import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
const token = readFileSync(join(homedir(), '.dsh', 'github-token.txt'), 'utf8').trim()
const H = { authorization: 'Bearer ' + token, accept: 'application/vnd.github+json', 'user-agent': 'dsh-live2d-pet' }
const api = async (p) => { const r = await fetch('https://api.github.com' + p, { headers: H }); const t = await r.text(); try { return { status: r.status, body: t === '' ? null : JSON.parse(t) } } catch { return { status: r.status, body: t } } }
const UP = 'awesome-dsh-plugin/awesome-dsh-plugin'
const runs = await api('/repos/' + UP + '/actions/runs?head_sha=0c52dba04c86b1a04dcbbdc3a04dd1b8f0b04a1a')
let sha = (await api('/repos/' + UP + '/pulls/5611')).body.head.sha
const rr = await api('/repos/' + UP + '/actions/runs?head_sha=' + sha + '&per_page=5')
console.log('runs=' + (rr.body.workflow_runs ?? []).length)
for (const run of (rr.body.workflow_runs ?? [])) {
  console.log('run ' + run.id + ' ' + run.name + ' ' + run.status + '/' + run.conclusion + ' ' + run.html_url)
  const jobs = await api('/repos/' + UP + '/actions/runs/' + run.id + '/jobs')
  for (const job of (jobs.body.jobs ?? [])) {
    console.log('  job: ' + job.name + ' ' + job.conclusion)
    for (const st of (job.steps ?? [])) console.log('    [' + st.conclusion + '] ' + st.name)
  }
}
const checks = await api('/repos/' + UP + '/commits/' + sha + '/check-runs')
for (const c of (checks.body.check_runs ?? [])) {
  console.log('--- ' + c.name + ' => ' + c.conclusion)
  if (c.output) console.log('  title: ' + c.output.title + '\n  summary: ' + String(c.output.summary ?? '').slice(0, 1500) + '\n  text: ' + String(c.output.text ?? '').slice(0, 1500))
}