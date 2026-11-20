# Test-owned parent reaps the controller and its surviving helper after the observation.
import ctypes, json, os, signal, sys
try:
    assert ctypes.CDLL(None).prctl(36, 1, 0, 0, 0) == 0
except AttributeError:
    pass
read_fd, write_fd = os.pipe()
controller = os.fork()
if controller == 0:
    os.close(read_fd)
    os.setsid()
    helper = os.fork()
    if helper == 0:
        os.close(write_fd)
        while True: signal.pause()
    os.write(write_fd, str(helper).encode())
    os.close(write_fd)
    while True: signal.pause()
os.close(write_fd)
helper = int(os.read(read_fd, 100))
os.close(read_fd)
print(json.dumps(dict(controller=controller, helper=helper)), flush=True)
try:
    for line in sys.stdin:
        if line.strip() == 'kill':
            os.kill(controller, signal.SIGKILL)
            if hasattr(os, 'waitid') and hasattr(os, 'WNOWAIT'):
                os.waitid(os.P_PID, controller, os.WEXITED | os.WNOWAIT)
            else: os.waitpid(controller, 0)
            print(json.dumps(dict(dead=True)), flush=True)
        else: break
finally:
    try: os.killpg(controller, signal.SIGKILL)
    except ProcessLookupError: pass
    while True:
        try: os.waitpid(-1, 0)
        except ChildProcessError: break
