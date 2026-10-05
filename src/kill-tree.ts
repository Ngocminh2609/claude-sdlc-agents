import { spawn } from "node:child_process";

/**
 * Stops a process and everything it spawned. `child.kill()` alone would leave
 * the grandchildren (tsx, a dev server, Playwright's browsers and web servers)
 * running and holding ports. On POSIX the process must have been spawned with
 * `detached: true`, so it leads its own process group; on Windows `taskkill /T`
 * walks the tree instead (detaching there would pop a console window).
 */
export function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already gone — nothing to stop.
    }
  }
}
