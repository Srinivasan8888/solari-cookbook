# A dependency cache that outlives the sandbox (TypeScript)

Sandboxes are ephemeral, so every run re-downloads the same packages. A volume
is not: you create it separately, mount it at `sandboxes.create()`, and it
survives the sandbox being destroyed. Run this twice and the second install
starts from a cache the first one left behind.

One trap decides the design. Volumes are s3fs, and **s3fs does not support
hardlinks**:

```
npm ERR! code ENOTSUP
npm ERR! syscall link
npm ERR! path /root/.npm/_cacache/tmp/...
```

npm's cacache finalises every download by `link()`-ing a temp file into
content-addressed storage, so mounting the volume directly at `~/.npm` fails on
the very first package. pnpm's store and `git clone --local` need hardlinks
too. So the cache stays on local disk and the volume holds an archive of it:
restore on the way in, re-archive on the way out.

Measured 2026-09-08. Every run installed the same 329 packages:

| run | restore | install | total |
| --- | --- | --- | --- |
| no volume | — | 13679ms | 13679ms |
| volume, cold | 317ms | 14514ms | 14831ms |
| volume, warm | 1014ms | 7568ms | **8582ms** |

**37% faster warm**, restore included. The cold run is slower than using no
volume at all, which is the honest shape of any cache: you pay once to fill it,
and win on every run after.

The warm figure reproduced to within 8ms across two separate sandboxes on
different runs (8590ms and 8582ms), so it is the cache doing the work rather
than a lucky registry response.

The example prints the package count next to the timing on purpose. An install
that fails installs nothing very quickly, and that is exactly what a broken
cache looks like if you only measure seconds.

## Run

```bash
cd examples/sandbox-volume-cache-ts
npm install
export SOLARI_API_KEY=slr_live_...   # https://console.getsolari.com
npm start                            # cold
npm start                            # warm
```

The volume is left in place between runs, because that is the point. Delete it
with `pt.volumes.delete(id)` when you stop wanting to pay for it.

Source: [`index.ts`](index.ts)
