# Performance gate

`hack/perf-gate.sh` runs the Go benchmarks of the base commit and of the
change on the same machine, one round each, 8 rounds, interleaved so that
drift on the machine affects both alike. `hack/perfgate` then compares
them, benchmark by benchmark and metric by metric (ns/op, B/op,
allocs/op, MB/s, and the custom metrics bytes/pod and MB/snapshot).

A metric fails the check when both hold:

- its median got worse by more than 10 % (for MB/s, lower is worse);
- the two samples really differ: Mann-Whitney U, p < 0.05. allocs/op is
  deterministic, so for it any growth past 10 % counts.

CI (`perf` job) compares a pull request against its base branch, and a
push to main against the previous commit. It posts the table in the job
summary and keeps the raw runs (`perf-results`) for 30 days. The base is
measured again in every run instead of being stored, because shared
runners differ from run to run more than 10 %.

Benchmarks covered:

- **Event path:** one pod change through the hub, 10k pods.
- **Snapshot encoding:** 10k and 50k pods.
- **Synthetic generation:** 50k pods.
- **Pod list decoding:** JSON and protobuf.

## Noise floor

Measured with `AA=1 hack/perf-gate.sh`, which runs the same code as base
and as change. Linux VM, 4 cores, 8 rounds:

| Benchmark | Median difference | p |
|---|---|---|
| Decode pod list (JSON) | +7.9 % | 0.083 |
| Decode pod list (protobuf) | −3.0 % | 0.71 |
| Event path, 10k pods | +0.3 % | 0.92 |
| Generate 50k | +3.9 % | 0.32 |
| Snapshot 10k | +1.3 % | 0.64 |
| Snapshot 50k | +3.4 % | 0.71 |

On this VM, medians of the same code differ by up to about 8 %. None
reached p < 0.05, so the gate raised no false alarm. A real regression
of 10 % or more is outside this noise, and over 8 rounds it reaches
significance (see the tests in `hack/perfgate`). If the gate fails, run
the job again: a regression that reproduces is real.

## Chromium

The in-app table benchmark (10k pods, 1,000 changes/s) runs in the same
job, and its numbers go to the summary: load, scroll frames, search,
sort and inspector. It is not gated. Frame times on a shared runner
without a GPU vary by more than 10 %, so a gate there would fail
changes at random. The native benchmarks (`hack/bench.sh`,
`hack/measure-macos.sh`) remain the reference for those numbers.

## Speed, energy and freshness together

The gate's benchmarks do a fixed amount of work per operation, so they
are faster only when the code is. An energy saving that comes from doing
less or showing data later shows up elsewhere: the idle benchmark
(`hack/bench.sh idle`) reports wakeups alongside freshness, and the
stream stats report queue age. A comparison with another tool must use
the same scope, the same metrics settings and the same freshness.
