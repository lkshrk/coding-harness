import { describe, expect, test } from 'bun:test'
import { type GuardDecision, guardLinearCommand } from './linear-guard'

const valid = [
  '## Goal\nAdd a retry queue.',
  '## Why\nSyncs fail on hiccups.',
  '## Design excerpt\n[design](https://linear.app/x/document/d)',
  '## Interfaces in\nnone',
  '## Interfaces out\nnone',
  '## Files\n- src/retry.ts',
  '## Constraints\nnone',
  '## Out of scope\nnone',
  '## Acceptance criteria\n- retries 503',
  '## Tests expected\n- retry.test.ts',
  '## Verify\n- `bun test`',
].join('\n\n')

const files: Record<string, string> = {
  '/tmp/ok.md': valid,
  '/tmp/no-verify.md': valid.replace(/\n\n## Verify[\s\S]*$/, ''),
  '/tmp/no-design.md': valid.replace('[design](https://linear.app/x/document/d)', 'none'),
  '/tmp/my file.md': valid,
}

const ctx = {
  readFile(path: string): string {
    const content = files[path]
    if (content === undefined) throw new Error(`ENOENT: ${path}`)
    return content
  },
}

const guard = (command: string, allowNoDesign?: boolean): GuardDecision =>
  guardLinearCommand(command, allowNoDesign === undefined ? ctx : { ...ctx, allowNoDesign })

const ALLOW: GuardDecision = { allow: true }
const deny = (message: string): GuardDecision => ({ allow: false, message })

const STATUS = deny('linear-guard: status is set by the supervisor')
const STAGE = deny('linear-guard: ai-stage labels are set by the supervisor')
const MERGE = deny('linear-guard: merge mode is set by ns implement')
const DELETE = deny('linear-guard: deleting is not allowed')
const INLINE = deny('linear-guard: pass the description as a file')
const UNKNOWN = deny('linear-guard: unknown write command')
const CHDIR = deny('linear-guard: use an absolute description file path after changing directory')
const UNPARSEABLE = deny('linear-guard: cannot parse the command; run the linear write on its own')

const cases: [string, GuardDecision][] = [
  ['linear issue view XXX-1 --json', ALLOW],
  ["linear issue list --json | jq -r '.[] | .identifier'", ALLOW],
  ['linear issue query --search "retry queue" --limit 20 --json | jq \'.[] | "\\(.identifier)"\'', ALLOW],
  ['linear issue comment list XXX-1 --json', ALLOW],
  ['linear issue relation list XXX-1', ALLOW],
  ['linear project list --team XXX --json | jq -r ".[] | .name" | head -5', ALLOW],
  ['linear document view abc --raw', ALLOW],
  ['linear team states XXX --json', ALLOW],
  ['git log --oneline | head', ALLOW],
  ['rg -n "linear issue delete" docs', ALLOW],
  ['echo "unterminated', ALLOW],

  ['linear issue create --no-interactive --team XXX --title "Retry" --description-file /tmp/ok.md', ALLOW],
  ["linear issue create --team XXX --title 'Retry' --description-file '/tmp/my file.md'", ALLOW],
  ['linear issue create --team XXX --description-file=/tmp/ok.md', ALLOW],
  [
    'linear issue create --team XXX --description-file /tmp/no-verify.md',
    deny('linear-guard: new issue: missing section ## Verify'),
  ],
  [
    'linear issue update XXX-51 --description-file /tmp/no-verify.md',
    deny('linear-guard: XXX-51: missing section ## Verify'),
  ],
  [
    'linear issue update XXX-51 --description-file /tmp/no-design.md',
    deny("linear-guard: XXX-51: ## Design excerpt: 'none' is not allowed"),
  ],
  [
    'linear issue update XXX-51 --description-file /tmp/missing.md',
    deny('linear-guard: cannot read /tmp/missing.md'),
  ],
  ['linear issue update XXX-51 --title "Better title" --estimate 3', ALLOW],
  ['linear issue create --team XXX --title "Retry"', INLINE],
  ['linear issue create --team XXX --title "Retry" --description "## Goal"', INLINE],
  ['linear issue update XXX-51 -d "inline"', INLINE],

  ['linear issue update XXX-51 --state Done', STATUS],
  ['linear issue update XXX-51 -s started', STATUS],
  ['linear issue update XXX-51 --state=Done', STATUS],
  ['linear issue create --team XXX --description-file /tmp/ok.md --start', STATUS],
  ['linear issue start XXX-51', STATUS],
  ['linear project update abc --status completed', STATUS],

  ['linear issue update XXX-51 --label ai-stage:review', STAGE],
  ['linear issue update XXX-51 --add-label "ai-stage:implement"', STAGE],
  ['linear issue update XXX-51 --remove-label=ai-stage:review', STAGE],
  ['linear issue create --team XXX --description-file /tmp/ok.md -l bug,ai-stage:ready', STAGE],
  ['linear project update abc --label ai-merge:auto', MERGE],
  ['linear project create --team XXX --name P --label "ai-merge:manual"', MERGE],

  ['linear issue delete XXX-51', DELETE],
  ['linear issue comment delete abc', DELETE],
  ['linear issue relation delete XXX-1 blocks XXX-2', DELETE],
  ['linear project delete abc', DELETE],
  ['linear document delete abc', DELETE],
  ['linear issue archive XXX-51', DELETE],

  ['linear issue comment add XXX-51 --body-file /tmp/c.md', ALLOW],
  ['linear issue relation add XXX-51 blocks XXX-52', ALLOW],
  ['linear issue relation add XXX-51 blocks XXX-51', deny('linear-guard: XXX-51 cannot block itself')],
  ['linear issue relation add XXX-51 blocked-by XXX-51', deny('linear-guard: XXX-51 cannot block itself')],
  [
    'linear project create --team XXX --name P --description "one line" --content-file /tmp/p.md --json',
    ALLOW,
  ],
  ['linear project update abc --description "one line" --target-date 2026-11-01', ALLOW],
  ['linear document create --title Design --project P --content-file /tmp/design.md', ALLOW],
  ['linear document update abc --content-file /tmp/design.md', ALLOW],

  ['linear api "mutation { issueDelete(id: \\"x\\") { success } }"', UNKNOWN],
  ['linear auth login', UNKNOWN],
  ['linear milestone create --project P --name M', UNKNOWN],
  ['linear issue pull-request XXX-51', UNKNOWN],

  ['linear issue view XXX-1 && linear issue update XXX-1 --state Done', STATUS],
  ['linear issue view XXX-1; linear issue delete XXX-1', DELETE],
  ['true || linear issue delete XXX-1', DELETE],
  ['linear issue view XXX-1 | linear issue delete XXX-1', DELETE],
  ['linear issue view XXX-1\nlinear issue delete XXX-1', DELETE],
  ['linear issue view XXX-1 & linear issue delete XXX-1', DELETE],
  ['linear issue view XXX-1 > /tmp/out.json && linear issue delete XXX-1', DELETE],
  ['linear issue view XXX-1 --json 2>/dev/null | jq .title', ALLOW],

  ['LINEAR_API_KEY=x linear issue delete XXX-1', DELETE],
  ['env LINEAR_TEAM=XXX linear issue update XXX-1 --state Done', STATUS],
  ['rtk linear issue delete XXX-1', DELETE],
  ['rtk linear issue list --json', ALLOW],
  ['/usr/local/bin/linear issue delete XXX-1', DELETE],
  ['echo XXX-1 | xargs -I{} linear issue delete {}', DELETE],
  ['bash -c "linear issue update XXX-1 --state Done"', STATUS],
  ["sh -c 'linear issue view XXX-1'", ALLOW],
  ["bash -lc 'linear issue delete XXX-1'", DELETE],
  ['sh -ec "linear issue update XXX-1 --state Done"', STATUS],
  ["zsh -xlc 'linear issue delete XXX-1'", DELETE],
  ["bash -o pipefail -c 'linear issue delete XXX-1'", DELETE],
  ["bash --login -c 'linear issue delete XXX-1'", DELETE],
  ["bash -lc 'linear issue list --json | jq .'", ALLOW],
  ['bash -l script.sh linear issue delete XXX-1', UNPARSEABLE],
  ['"linear" issue delete XXX-1', DELETE],
  ['linear issue \\\n  delete XXX-1', DELETE],
  ['linear issue view XXX-1 # linear issue delete XXX-1', ALLOW],

  ['if true; then linear issue delete XXX-1; fi', DELETE],
  ['if linear issue delete XXX-1; then true; fi', DELETE],
  ['while true; do linear issue delete XXX-1; done', DELETE],
  ['true; else linear issue update XXX-1 --state Done', STATUS],
  ['! linear issue delete XXX-1', DELETE],
  ['{ linear issue delete XXX-1; }', DELETE],
  ['then FOO=1 rtk linear issue delete XXX-1', DELETE],
  ['for i in 1; do linear issue view XXX-1 --json; done', ALLOW],
  ['foo linear issue delete XXX-1', UNPARSEABLE],
  ['case x in y) linear issue delete XXX-1;; esac', UNPARSEABLE],

  ['cd /tmp && linear issue create --team XXX --description-file ok.md', CHDIR],
  ['cd /other; linear issue create --team XXX --description-file /tmp/ok.md', ALLOW],
  ['pushd /x && linear issue update XXX-1 --description-file=./ok.md', CHDIR],
  ['cd /x && bash -c "linear issue update XXX-1 --description-file ok.md"', CHDIR],
  ['bash -c "cd /x; linear issue update XXX-1 --description-file ok.md"', CHDIR],
  ['env -C /x linear issue create --team XXX --description-file ok.md', CHDIR],
  ['then cd /x; linear issue create --team XXX --description-file ok.md', CHDIR],

  ['linear issue update XXX-1 --title "$(cat /tmp/t)"', UNPARSEABLE],
  ['linear issue update XXX-1 --title `cat /tmp/t`', UNPARSEABLE],
  ['(linear issue delete XXX-1)', UNPARSEABLE],
  ['linear issue create --title "open', UNPARSEABLE],
  ['linear issue comment add XXX-1 --body-file <(echo hi)', UNPARSEABLE],
  ['\'lin\'ear issue delete XXX-1 --title "$(cat /tmp/t)"', UNPARSEABLE],
  ['lin""ear issue delete XXX-1 --title "$(cat /tmp/t)"', UNPARSEABLE],
  ['li\\near issue delete XXX-1 --title "$(cat /tmp/t)"', UNPARSEABLE],
  ['echo "$(date)" done', ALLOW],

  ['L=linear; $L issue delete XXX-1', UNPARSEABLE],
  ['$L issue delete XXX-1', UNPARSEABLE],
  ['"$L" issue update XXX-1 --state Done', UNPARSEABLE],
  ['${L} issue delete XXX-1', UNPARSEABLE],
  ['$HOME/bin/linear issue delete XXX-1', UNPARSEABLE],
  ['rtk $L issue delete XXX-1', UNPARSEABLE],
  ['env FOO=1 $L issue delete XXX-1', UNPARSEABLE],
  ['then $L issue delete XXX-1', UNPARSEABLE],
  ['bash -c "$S"', UNPARSEABLE],
  ['S="linear issue delete XXX-1"; bash -c "$S"', UNPARSEABLE],
  ['eval "$S delete"', UNPARSEABLE],
  ['/usr/bin/line?r issue delete XXX-1', UNPARSEABLE],
  ['echo "issue delete XXX-1" | xargs linear', UNPARSEABLE],
  ['$PAGER /tmp/out.json', UNPARSEABLE],
  ["$'linear' issue delete XXX-1", UNPARSEABLE],
  ['sudo -u $U linear issue view XXX-1', UNPARSEABLE],
  ['nice -n 5 $L issue delete XXX-1', UNPARSEABLE],
  ['timeout 5 linear issue delete XXX-1', DELETE],
  ['echo XXX-1 | xargs -I {} linear issue view {}', ALLOW],
  ['[ -f /tmp/ok.md ] && linear issue view XXX-1', ALLOW],
  ['[[ -f /tmp/ok.md ]] && linear issue view XXX-1', ALLOW],
  ['rtk jq . "$F"', ALLOW],
]

describe('guardLinearCommand', () => {
  test.each(cases)('%s', (command, expected) => {
    expect(guard(command)).toEqual(expected)
  })

  test('allowNoDesign accepts an issue without a design excerpt', () => {
    expect(guard('linear issue update XXX-51 --description-file /tmp/no-design.md', true)).toEqual(ALLOW)
  })

  test('joins several validator messages on one line', () => {
    const decision = guard('linear issue update XXX-51 --description-file /tmp/c.md')
    expect(decision).toEqual(deny('linear-guard: cannot read /tmp/c.md'))
    files['/tmp/c.md'] = '## Goal\nx'
    const multi = guard('linear issue update XXX-51 --description-file /tmp/c.md')
    delete files['/tmp/c.md']
    expect(multi.allow).toBe(false)
    if (multi.allow) return
    expect(multi.message).toStartWith('linear-guard: XXX-51: missing section ## Why; ')
    expect(multi.message).not.toContain('\n')
  })
})
