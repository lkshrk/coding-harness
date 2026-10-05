// Git exports these to hooks and they override `git -C`, so fixture repos would write into this checkout.
const leaked = Object.keys(process.env).filter((k) =>
  /^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|PREFIX)$/.test(
    k,
  ),
)
if (leaked.length) {
  console.error(`refusing to run tests with ${leaked.join(', ')} set; use \`bun run test\``)
  process.exit(1)
}
