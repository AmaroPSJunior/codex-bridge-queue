#!/data/data/com.termux/files/usr/bin/python3
"""Independent, fail-closed recovery controller for Code Bridge."""
from __future__ import annotations
import argparse, fcntl, json, os, shutil, stat, subprocess, sys, time
from pathlib import Path

HOME=Path.home()
BASE=HOME/".local/share/codex-bridge"
SLOTS=BASE/"slots"
CURRENT=BASE/"current"
STATE=HOME/".config/codex-bridge/recovery"
LEGACY=HOME/"codex-bridge-main"
REPO="https://github.com/AmaroPSJunior/codex-bridge-queue.git"

def run(args,cwd=None,check=True,timeout=600):
    return subprocess.run(args,cwd=cwd,text=True,capture_output=True,check=check,timeout=timeout)

def write_json(path,data):
    path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    tmp=path.with_name(path.name+".tmp")
    tmp.write_text(json.dumps(data,sort_keys=True))
    os.chmod(tmp,0o600)
    os.replace(tmp,path)

def lock():
    STATE.mkdir(parents=True,exist_ok=True,mode=0o700)
    fd=os.open(STATE/"recovery.lock",os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
    fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
    return fd

def active():
    try: return CURRENT.resolve(strict=True)
    except FileNotFoundError: return None

def workers(root=None):
    target=(root/"supabase-worker.js").resolve() if root else None
    found=[]
    for proc in Path("/proc").glob("[0-9]*"):
        try:
            args=(proc/"cmdline").read_bytes().split(b"\0")
            cwd=Path(os.readlink(proc/"cwd"))
            candidates=[(cwd/os.fsdecode(a)).resolve() for a in args[1:] if a]
            if (target and target in candidates) or (not target and any(p.name=="supabase-worker.js" for p in candidates)):
                found.append(int(proc.name))
        except (OSError,ValueError):
            pass
    return sorted(found)

def validate(root):
    required=["supabase-worker.js","autostart/supabase-launcher.py","autostart/control-bootstrap.py","package.json"]
    if any(not (root/p).is_file() for p in required):
        raise RuntimeError("invalid_checkout")
    run(["node","--check","supabase-worker.js"],root)
    run([sys.executable,"-m","py_compile","autostart/supabase-launcher.py","autostart/control-bootstrap.py"],root)
    run(["npm","test"],root)

def prepare(dst):
    if dst.exists(): shutil.rmtree(dst)
    dst.parent.mkdir(parents=True,exist_ok=True)
    run(["git","clone","--depth=1","--branch","main",REPO,str(dst)],timeout=300)
    # Runtime dependencies belong to the prepared slot; validate and promote only a runnable checkout.
    run(["npm","ci","--omit=dev","--ignore-scripts"],dst,timeout=300)
    validate(dst)
    return run(["git","rev-parse","HEAD"],dst).stdout.strip()

def switch(dst):
    BASE.mkdir(parents=True,exist_ok=True)
    tmp=BASE/"current.next"
    try: tmp.unlink()
    except FileNotFoundError: pass
    tmp.symlink_to(dst)
    os.replace(tmp,CURRENT)

def status():
    a=active()
    journal=STATE/"journal.json"
    out={"active":str(a) if a else None,"workers":workers()}
    if journal.exists(): out["journal"]=json.loads(journal.read_text())
    print(json.dumps(out))

def recover():
    fd=lock()
    try:
        before=active()
        if workers():
            raise RuntimeError("active_worker_present_use_controlled_drain_first")
        dst=SLOTS/("B" if before and before.name=="A" else "A")
        write_json(STATE/"journal.json",{"phase":"preparing","previous":str(before) if before else None,"target":str(dst),"at":time.time()})
        sha=prepare(dst)
        write_json(STATE/"journal.json",{"phase":"validated","previous":str(before) if before else None,"target":str(dst),"sha":sha,"at":time.time()})
        switch(dst)
        env=os.environ.copy()
        env["CODEX_BRIDGE_DEVICE_ROUTING_V1"]="1"
        p=subprocess.run([sys.executable,str(dst/"autostart/supabase-launcher.py")],cwd=dst,env=env,text=True,capture_output=True,timeout=30)
        if p.returncode: raise RuntimeError("launcher_failed")
        time.sleep(3)
        data=json.loads(run([sys.executable,str(dst/"autostart/supabase-launcher.py"),"--status"],dst).stdout)
        slot_workers=workers(dst)
        global_workers=workers()
        reported=sorted(data.get("worker_pids",[]))
        healthy=(len(global_workers)==1 and global_workers==slot_workers and global_workers==reported)
        if not healthy:
            # Never certify a checkout-local view while another generation is alive.
            # Fail closed: preserve evidence and do not start another generation here.
            write_json(STATE/"journal.json",{"phase":"health_failed","failed_sha":sha,"previous":str(before) if before else None,"target":str(dst),"global_worker_pids":global_workers,"slot_worker_pids":slot_workers,"reported_worker_pids":reported,"at":time.time()})
            raise RuntimeError("global_health_check_failed")
        write_json(STATE/"journal.json",{"phase":"healthy","active":str(dst),"sha":sha,"worker_pids":global_workers,"at":time.time()})
        status()
    finally:
        os.close(fd)

def install():
    dst=HOME/".local/bin/bridge-recover"
    dst.parent.mkdir(parents=True,exist_ok=True)
    shutil.copy2(Path(__file__).resolve(),dst)
    os.chmod(dst,0o700)
    cli_src=Path(__file__).resolve().with_name("bridge")
    cli_dst=HOME/".local/bin/bridge"
    if cli_src.is_file():
        shutil.copy2(cli_src,cli_dst)
        os.chmod(cli_dst,0o700)
    reboot_src=Path(__file__).resolve().with_name("bridge-reboot")
    reboot_dst=HOME/".local/bin/bridge-reboot"
    if reboot_src.is_file():
        shutil.copy2(reboot_src,reboot_dst)
        os.chmod(reboot_dst,0o700)
    # Keep bootstrap version available before an A/B runtime is activated.
    source_root=Path(__file__).resolve().parent.parent
    version=run(["git","-C",str(source_root),"rev-parse","--short","HEAD"],check=False)
    if version.returncode == 0:
        version_dst=dst.with_name("bridge-version")
        version_dst.write_text(version.stdout.strip()+"\n")
        os.chmod(version_dst,0o600)
    # Migrate Termux:Boot away from legacy checkouts before any recovery drain.
    boot_src=Path(__file__).resolve().parent.parent/"autostart/20-codex-bridge"
    boot_dir=HOME/".termux/boot"
    boot_dst=boot_dir/"20-codex-bridge"
    if boot_src.is_file():
        boot_dir.mkdir(parents=True,exist_ok=True,mode=0o700)
        if boot_dir.is_symlink() or not boot_dir.is_dir():
            raise RuntimeError("unsafe_boot_directory")
        tmp=boot_dir/".20-codex-bridge.tmp"
        shutil.copy2(boot_src,tmp)
        os.chmod(tmp,0o700)
        os.replace(tmp,boot_dst)
    print(str(dst))

def main():
    p=argparse.ArgumentParser()
    p.add_argument("command",choices=["status","recover","install"])
    a=p.parse_args()
    {"status":status,"recover":recover,"install":install}[a.command]()

if __name__=="__main__":
    try: main()
    except BlockingIOError:
        print("recovery already running",file=sys.stderr); sys.exit(2)
    except Exception as e:
        print("bridge-recover failed safely: "+str(e),file=sys.stderr); sys.exit(1)
