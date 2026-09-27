import { execFile } from "node:child_process"

const rewrite = (command: string) =>
  new Promise<string>((resolve) => {
    execFile("rtk", ["rewrite", command], { timeout: 2000 }, (_error, stdout) => {
      // Exit codes also signal "rewritten with caveats"; empty output means run the command unchanged.
      resolve(String(stdout ?? "").trim() || command)
    })
  })

export default {
  id: "rtk",
  setup(ctx: { shell: { hook: (name: "create.before", callback: (event: { command: string }) => Promise<void>) => unknown } }) {
    ctx.shell.hook("create.before", async (event) => {
      event.command = await rewrite(event.command)
    })
  },
}
