# Mario Zechner (@badlogicgames): Pi Android app ("pi mobile" / "p2") research bundle

Compiled Tue Oct 20, 2026 (PT) for Will Hampson's phone agent. **This file is self-contained**: you do not need X/Twitter access. Every tweet quoted below is reproduced in full, with its link for reference only.

**Sources**: (a) 15 tweets verified by Will via the X API (marked "verified via X API"); (b) a scrape of Mario's posts (`_db.json` on Will's box, `/workspace/badlogic-torture/`); (c) screenshots and video stills of those posts, reviewed for an earlier handoff (`HANDOFF.md`) and spec (`SPEC.md`) on the same box; (d) Mario's public benchmark repo `badlogic/durable-bench` (script `harness/scripts/slayer.sh`, `harness/README.md`, `harness/Dockerfile`).

**Conventions**
- All times are Pacific Time (America/Los_Angeles, UTC-7 in October 2026), labeled "PT". Tweet timestamps were converted from UTC.
- Evidence tags: **[Mario]** he said it in a post; **[media]** seen in a screenshot of his post; **[video]** from still frames / reviewer notes of his videos (videos were not reviewed with audio); **[bench]** from his durable-bench repo; **[inferred]** our reading, not confirmed by him.
- Mario's app was first called "pi mobile" / "Pi Mobile" (Android package `works.earendil.pi.mobile`), and by Oct 11 appears as **p2** (`p2.mariozechner.at`). Will's own project is **p2w** / `Whamp/pi-mobile`. Don't confuse them.
- Glossary: **brain** = the agent loop (model calls, transcript); **hands / execution env** = where tools like `bash`, `read`, `edit` run; **durable** = every step checkpointed so a killed process resumes; **replay-safe** = a tool that may safely re-run after a crash (`bash` is not); **codemode** = model writes a JS script that calls tools (`await tools.bash(...)`); **steer** = message injected into a running turn.

---

## 1. TL;DR: key findings

- **Native Android app announced Sat Oct 4, 2:12 PM PT** [Mario, 2106855108680024232]: "android native app achieved,.no more termux needed ... not a product, but a pi durable demo. built in 2 days on my phone with .. pi durable." It is a bespoke app built from parts ripped out of Termux (userland emulation + background keep-alive) [Mario, 2111366160205987847, 2111369852111786259]. Runs on a **Pixel 11, not rooted, a few hundred MB RAM with many sessions** [Mario, 2111342152513208371]. Despite "no more termux needed", Termux paths and a "Termux 1 session" notification still appear Oct 11 [video 2109413968552820840] and on Oct 16 he says the "termux process is forcibly kept alive via a setting" [Mario, 2111214825154179397]. Which one is his daily runtime by Oct 19 is unclear.
- **Brain on the phone, only the tools move.** "everything except the llm runs on my phone" [Mario, 2107236034199126242]. On Oct 5 the agent switched its execution environment from the phone to a remote host *in the same session*; "it's brain stays on my phone" [Mario, 2107238740230078520]. The agent loop, transcript, durable storage, UI server and artifacts stay on the phone; only tool calls (bash/read/edit/...) run remotely over SSH [media 2107238740230078520: "The commands run over SSH on slayer"].
- **Slayer = Mario's remote server `slayer.marioslab.io`.** Screenshot: "I'm on the remote host slayer (slayer.marioslab.io), which runs Ubuntu 22.04 on x86_64, signed in as badlogic", cwd `/home/badlogic/pi-mono` [media 2107238740230078520]. His benchmark script describes it as "the dedicated host 'slayer'" with an **i9-13900** and **Docker** (it builds and runs a `dhb-bench` container there) [bench]. An Oct 12 screenshot (probably slayer [inferred]) shows Linux 5.15 x86_64, uptime > 1 year, `/dev/md2` 1.7T. Asked "Slayer is your remote session in hetzner vm?" he answered "no, just a remote execution env i can switch my phone agent too" [Mario, 2112092325237145858].
- **Slayer is distinct from his Hetzner box.** He separately says parakeet speech-to-text runs "on my hetzner" [Mario, 2112119334046667011]. Confusingly, the Oct 5 tweet text says "e.g. my hetzner" while its screenshot shows slayer. Best reading: slayer and "my hetzner" are two different machines; slayer is the one his phone agent switches its tools to [inferred from 2112092325237145858 + screenshot].
- **How he reaches slayer (from his benchmark script, `harness/scripts/slayer.sh`)** [bench]:
  - Host: `badlogic@slayer.marioslab.io`, overridable with env var **`SLAYER_HOST`**.
  - SSH key: `${SLAYER_KEY:-$HOME/.pi/mobile/ssh/keys/slayer}` (env var **`SLAYER_KEY`**).
  - Known hosts: `$HOME/.pi/mobile/ssh/known_hosts`; **`HostKeyAlias=pi-env-slayer`**; `StrictHostKeyChecking=yes`, `BatchMode=yes`, `ConnectTimeout=30`.
  - "The host drops bursts of new connections": the script retries SSH connection failures (exit 255) up to 5 times with linear backoff (`sleep i*15` s).
  - Docker container pinned with `--cpuset-cpus=4` ("one hardware thread of a P-core on the i9-13900"), `--memory=8g`.
  - **Caveat**: these values come from his *benchmark* script, not from p2's own config (p2 is private). The `~/.pi/mobile/ssh/...` paths and the `pi-env-<name>` alias pattern strongly suggest the script reuses the SSH material that pi mobile's env feature created [inferred]; pi-env (`@earendil-works/pi-env`) also deploys its daemon to `~/.pi/mobile/tools/` (per SPEC reading of pi source).
- **Oct 11 durable codemode restart test (12 steps)** [media 2109402647933702520, video 2109408108896563242]:
  - Script: `mkdir -p /tmp/durable-codemode && echo "start $(date +%T)" >> /tmp/durable-codemode/restart.log`; then `for i in 1..12`: `try { await tools.bash({command: \`sleep 10; echo "${i} $(date +%T)" >> /tmp/durable-codemode/restart.log; echo ${i}\`}); results.push("i: ok") } catch (e) { results.push("i: error " + first line of e.message) }`; finally `cat` the log and `return { results, log }`. Tools ran on slayer.
  - Kill method shown on screen: "On SIGTERM the worker closes the Harness first and exits after at most 1.5 s. So archiving is either a clean Harness close or, if that takes longer, a hard kill." He **archives** the session mid-run from the Session sheet, then **restores** it from the Archived tab.
  - Expected results listed on screen (= pass criteria): **no duplicate numbers** in the log; the **in-flight call reports interrupted and is caught**; **the rest continue** on their own.
  - Observed in the video: calls 1-2 OK (~10 s each), call 3 in flight; archived at ~0:31, restored at ~0:34; call 3 shows red **"Tool bash was interrupted and may have partially run"** (bash is not replay-safe, so it is not blindly re-run), the `catch` fires, and call 4 starts by itself. No step ran twice; treated as a pass. His comment: "all these things just fall out of durable execution in pi durable" [Mario, 2109408108896563242]. (pi-durable 1.2.0, Oct 12, shipped "durable codemode": the script is replayed from a journal of prior results and reattaches to in-flight tool calls.)
- **Oct 19 "phone dev" session** [media 2112085863408812097]: header `phone dev`, cwd `slayer:/home/badl…`; the agent explains: "This session's tools run on slayer, but the session itself runs in p2 on your phone." A Python script on slayer generated audio clips as MP3 inside an HTML file (`~/voice-bench/voice-test-f.html`, base64); a codemode script read it via `bash` in **45 KB chunks** (`tail -c … | head -c …`), each chunk travelling back to the phone as tool output; the script joined them and called the `artifact` tool, which saved it **on the phone under `~/.pi/p2`**. Footer: Claude Opus 5.5 · high, cost $220.41, context 16%/1.00M. Tunnel still `pim.ngrok.p…` in the URL bar.
- **His Termux advice** [Mario, 2111369852111786259]: "just point your agent at termux repo and say: i just need the usrrland emu and the background process stuff so my shit doesn't die."
- **Code state**: "it's not in a good state :D" [same tweet]. Oct 5: "decided to not publish this" [2107121062655774922]. Oct 11: pi durable is published; "the only thing we haven't published yet is this app ... soon" [2109416099200565580]. Oct 4: "we may release this little experiment next week, mayhaps" [2106707737048715303]. **As of Oct 20, 2026 the p2 source is private and unreleased; no repo or APK has been published** (none found in the captured posts).

---

## 2. Chronological timeline (all captured posts)

58 posts: every tweet ID in HANDOFF.md and SPEC.md, every post with saved media, the 15 API-verified tweets, and the @viticci context post. Quoted text is exact (`t.co` short links are left as captured; you cannot open them and they add no information here). Texts marked "verified via X API" were supplied by Will; others come from the scrape. No tweet was left without text.

### Fri Oct 2, 2026, 12:20 PM PT (@badlogicgames)
Link: https://x.com/badlogicgames/status/2106102082512339446

> neat! that reminded me that some said pi works in termux on Android early this year. still does! https://t.co/6jU8ey3d5v https://t.co/eMjMiw7sGw

- Significance: Starting point: plain pi (the coding agent) still runs in Termux on Android.
- Text source: _db.json; media on Will's box: 2106102082512339446_0.mp4

### Fri Oct 2, 2026, 12:40 PM PT (@badlogicgames)
Link: https://x.com/badlogicgames/status/2106107060958212121

> pi codemode on Android in termux :D https://t.co/409WMJcH8K

- Significance: pi codemode running in Termux on Android (screenshot).
- Text source: _db.json; media on Will's box: 2106107060958212121_0.png

### Sat Oct 3, 2026, 12:34 AM PT (@badlogicgames)
Link: https://x.com/badlogicgames/status/2106286641551675411

> this weekend, i'm finally replacing Claude for Android with a little pi durable thing that runs fully on my phone. building it directly in pi on my phone. and it has subagents :D
>
> (not an official earendil product, just a personal project to battle test durable) https://t.co/DgacgbSjHb

- Significance: Kickoff: personal project, "a pi durable thing that runs fully on my phone", built in pi on the phone, with subagents; explicitly not an official Earendil product.
- Text source: _db.json; media on Will's box: 2106286641551675411_0.mp4

### Sat Oct 3, 2026, 12:44 AM PT (@badlogicgames)
Link: https://x.com/badlogicgames/status/2106289171145101702

> and all of it runs on my phone (except the llm obv)

- Significance: Everything except LLM calls runs on the phone.
- Text source: _db.json

### Sat Oct 3, 2026, 5:02 AM PT (@badlogicgames)
Link: https://x.com/badlogicgames/status/2106354140343603217

> @baggiponte phone kills process, process respawns and just continues exactly where it left off.

- Significance: Durability on Android: the OS kills the process, it respawns and continues where it left off.
- Text source: _db.json

### Sat Oct 3, 2026, 6:57 AM PT (@badlogicgames)
Link: https://x.com/badlogicgames/status/2106383122183196709

> internal pi durable multiplayer achieved, all running on my Android phone, exposed via ngrok. https://t.co/qUwFTo3Z3F https://t.co/dPdFNfqvxs

- Significance: Multiplayer: guests (Armin Ronacher shown) join and steer; served from the phone via ngrok (pim.ngrok.pro in screenshot).
- Text source: _db.json; media on Will's box: 2106383122183196709_0.jpg

### Sat Oct 3, 2026, 7:14 AM PT (@badlogicgames)
Link: https://x.com/badlogicgames/status/2106387323390960086

> so now that it's bootstrapped, we can make it edit itself with hot reload :D
>
> which is simple. web > hmr. server/session workers > kill amd respawn, pi durable takes care of the rest :D https://t.co/6GgodArtN8

- Significance: Self-editing with hot reload: web via HMR; server/session workers are killed and respawned, durability restores state.
- Text source: _db.json; media on Will's box: 2106387323390960086_0.jpg

### Sat Oct 3, 2026, 8:09 AM PT (@badlogicgames)
Link: https://x.com/badlogicgames/status/2106401167915757634

> 130 viewers at one point, neither server nor pi durable bulged. very happy :) https://t.co/G8V7tZ3EZ5

- Significance: Load: about 130 viewers, no strain on server or pi durable.
- Text source: _db.json

### Sat Oct 3, 2026, 10:44 AM PT (@badlogicgames)
Link: https://x.com/badlogicgames/status/2106440272427016278

> @draslan_eth i've been running pi durable on my pixel 11 withiut the battery dying for 24 hours non-stop. ¯⁠\⁠_⁠(⁠ツ⁠)⁠_⁠/⁠¯

- Significance: Battery: 24 h non-stop on a Pixel 11.
- Text source: _db.json

### Sat Oct 3, 2026, 11:32 AM PT (@badlogicgames)
Link: https://x.com/badlogicgames/status/2106452296087302173

> well, this works better than Claude for Android or ChatGPT for Android has ever worked. It runs on my phone directly, no cloud vm. I can live edit it. Its multiplayer. And I can pick any provider/model. Just added artifacts.
>
> There is no moat. 24h of slop, developed on the phone, https://t.co/UdLkvcQNAT https://t.co/dPdFNfpXHU

- Significance: Claims parity-plus with Claude/ChatGPT Android apps: on-device, live-editable, multiplayer, any provider/model, artifacts added.
- Text source: _db.json; media on Will's box: 2106452296087302173_0.mp4

### Sat Oct 3, 2026, 1:44 PM PT (@badlogicgames)
Link: https://x.com/badlogicgames/status/2106485523317489902

> @somi_ai it doesn't it's a foreground service. since it's mostly waiting for llm reponses, it also barely costs any battery.
>
> compiling rust code would be a problem, granted.

- Significance: Keep-alive mechanism: Android foreground service; mostly idle waiting on LLM, so little battery.
- Text source: _db.json

### Sat Oct 3, 2026, 2:04 PM PT (@badlogicgames)
Link: https://x.com/badlogicgames/status/2106490627521409463

> @possibilities regular pi: server/session worker processes die due to code changes, you respawn the processes. you lost anything that was in progress.
>
> pi durable: same scenario, but you loose nothing, and things start running again automatically.

- Significance: Why durability matters for self-editing: regular pi loses in-progress work on respawn; pi durable loses nothing and auto-resumes.
- Text source: _db.json

### Sun Oct 4, 2026, 4:27 AM PT (@badlogicgames)
Link: https://x.com/badlogicgames/status/2106707737048715303

> at some fair, told pim to slop together paged historic transcript loads.
>
> we may release this little experiment next week, mayhaps. 100% slop on top of pi durable. https://t.co/t8nkHrOYuc

- Significance: Paged historic transcript loading; "may release this little experiment next week, mayhaps" (did not happen as of Oct 20).
- Text source: _db.json; media on Will's box: 2106707737048715303_0.mp4

### Sun Oct 4, 2026, 7:47 AM PT (@badlogicgames)
Link: https://x.com/badlogicgames/status/2106758114892820650

> @g_tutner cause opus wrote the initial frontend without guidance. looks different now. https://t.co/sIeYLpuFrf

- Significance: Frontend was originally written by Opus without guidance; redesigned since.
- Text source: _db.json; media on Will's box: 2106758114892820650_0.mp4

### Sun Oct 4, 2026, 11:46 AM PT (@badlogicgames)
Link: https://x.com/badlogicgames/status/2106818236264427975

> gave the agents a simple tool to find and message other active agents. have this in pi as well. going full gastown here.
>
> so now an agent can talk to it's background subagents, and other agents running on my Android phone. useful for context transfer and coordination. https://t.co/tYbPQ9eFR1

- Significance: Agent-to-agent messaging tool: agents find and message other active agents incl. background subagents on the phone.
- Text source: _db.json; media on Will's box: 2106818236264427975_0.mp4

### Sun Oct 4, 2026, 2:12 PM PT (@badlogicgames)
Link: https://x.com/badlogicgames/status/2106855108680024232

> android native app achieved,.no more termux needed. the little oauth 404 localhost blunder is due to the dev version already running. nice. again, not a product, but a pi durable demo. built in 2 days on my phone with .. pi durable.

- Significance: NATIVE ANDROID APP announced ("no more termux needed"); "not a product, but a pi durable demo"; built in 2 days on the phone.
- Text source: verified via X API; media on Will's box: 2106855108680024232_0.mp4

### Mon Oct 5, 2026, 1:19 AM PT (@badlogicgames)
Link: https://x.com/badlogicgames/status/2107022755744952709

> @MakJoris a library to build durable agents anywhere. including pi coding agent itself, or the pi mobile thing you see above.

- Significance: Defines pi durable: a library to build durable agents anywhere, incl. pi itself and "the pi mobile thing".
- Text source: verified via X API

### Mon Oct 5, 2026, 7:49 AM PT (@badlogicgames)
Link: https://x.com/badlogicgames/status/2107121062655774922

> day 3, cwd file browser and git viewer. inline comments that get back to the agent are in progress. then integration of switching execution env, so agent can jump from local to remote machine, while its brain still works on my phone.
>
> decided to not publish this. it's a slop https://t.co/HW3QbDzxBi https://t.co/UeL3uE9ufP

- Significance: Day 3: cwd file browser + git viewer; env switching announced as next; "decided to not publish this".
- Text source: _db.json; media on Will's box: 2107121062655774922_0.mp4

### Mon Oct 5, 2026, 7:52 AM PT (@badlogicgames)
Link: https://x.com/badlogicgames/status/2107121673811984637

> the entire thing is now 12k loc, including 6k loc frontend code.
>
> i think that's pretty minimal :) still needs codemode and mcp support to be a full design study we can play around with. that requires minor changes to pi durable itself.
>
> dogfooding.

- Significance: Size: ~12k LOC incl. 6k frontend; codemode + MCP support still to come (needed minor pi durable changes).
- Text source: _db.json

### Mon Oct 5, 2026, 3:09 PM PT (@badlogicgames)
Link: https://x.com/badlogicgames/status/2107231693568438767

> i knew that humongous android tablet of mine will eventually pay off after ... 4 years. this is really nice to work with. agents run on my phone, tablet connects to it.

- Significance: Android tablet browser connects to agents running on the phone.
- Text source: verified via X API; media on Will's box: 2107231693568438767_0.jpg

### Mon Oct 5, 2026, 3:26 PM PT (@badlogicgames)
Link: https://x.com/badlogicgames/status/2107236034199126242

> @goatbisceglia your a bit off. everything except the llm runs on my phone. pi durable is a library i use in this app which covers all the durable agent parts. the rest is the control plane and ui on top of it. https://earendil.com/posts/pi-durable/

- Significance: Architecture statement: everything except the LLM on the phone; pi durable = durable-agent parts; rest = control plane + UI.
- Text source: verified via X API

### Mon Oct 5, 2026, 3:37 PM PT (@badlogicgames)
Link: https://x.com/badlogicgames/status/2107238740230078520

> and for my final trick, the little agent on the phone can change its execution environment from the phone to e.g. my hetzner in the same session. it's brain stays on my phone. how nice.

- Significance: ENV SWITCHING: same session moves tools from phone to remote host; brain stays on phone. Text says "my hetzner", screenshot shows slayer (slayer.marioslab.io, Ubuntu 22.04 x86_64).
- Text source: verified via X API; media on Will's box: 2107238740230078520_0.jpg

### Tue Oct 6, 2026, 9:28 AM PT (@badlogicgames)
Link: https://x.com/badlogicgames/status/2107508318688235798

> now @mitsuhiko is joining in on the fun.
>
> would really like to get this into people's hands asap. need to rethink plugins again. not sure we want to go full chord. and making it secure in multiplayer is also a challenge. https://t.co/K56bHoG4Oe

- Significance: Armin (@mitsuhiko) running his own copy (on his Mac per SPEC correction, not connected to Mario's phone); plugins need a rethink ("not sure we want to go full chord"); multiplayer security is a challenge.
- Text source: _db.json; media on Will's box: 2107508318688235798_0.jpg

### Tue Oct 6, 2026, 1:59 PM PT (@badlogicgames)
Link: https://x.com/badlogicgames/status/2107576397959135728

> @arjunkmrm published the benchmark code, which allowed me to fix some stuff. cheers!
>
> then i had opus create a slide deck from the benchmark numbers.
>
> tardigrade is really fucking cool so take what follows as friendly banter (the numbers are real tho).
>
> high level results first. https://t.co/rGBXmbx2Np https://t.co/Dj8sZaKvfm

- Significance: Benchmark thread start: pi durable vs Tardigrade (friendly).
- Text source: _db.json; media on Will's box: 2107576397959135728_0.png

### Tue Oct 6, 2026, 1:59 PM PT (@badlogicgames)
Link: https://x.com/badlogicgames/status/2107576404686836022

> what is benchmarked here? i let my agent explain, so i don't have to type all that.
>
> tl;dr: seed sessions with N messages, then benchmark startup/submissions/turns, memory and disk usage. https://t.co/UL22b4XGby

- Significance: Benchmark method: seed sessions with N messages; measure startup/submit/turns, memory, disk.
- Text source: _db.json; media on Will's box: 2107576404686836022_0.jpg, 2107576404686836022_1.jpg

### Tue Oct 6, 2026, 1:59 PM PT (@badlogicgames)
Link: https://x.com/badlogicgames/status/2107576409400959477

> digging into it a little, cold and warm turn timings for each history size.
>
> tardigrade is event sourced. it keeps a log and snapshots its state every 500 events by default. a cold start reads the last snapshot plus the events after it, reduces and validates them. that snapshot https://t.co/ZwJGtoINz6

- Significance: Cold/warm turn timings; Tardigrade is event-sourced with snapshots every 500 events.
- Text source: _db.json; media on Will's box: 2107576409400959477_0.jpg

### Tue Oct 6, 2026, 1:59 PM PT (@badlogicgames)
Link: https://x.com/badlogicgames/status/2107576413331259574

> as i said, june's benchmark actually surfaced an issue in pi durable at this somewhat unrealistic history size. the fix was pretty small. the numbers below are before and after. all other numbers in this thread are with the fix.
>
> i also fixed up the benchmark harness and replaced https://t.co/1249GVEgL8

- Significance: Benchmark surfaced a pi durable issue at large history; small fix; numbers before/after (post-fix i9 numbers per HANDOFF: warm 82 vs 234 ms, cold 183 vs 1,617 ms at 3,500 turns).
- Text source: _db.json; media on Will's box: 2107576413331259574_0.png

### Tue Oct 6, 2026, 1:59 PM PT (@badlogicgames)
Link: https://x.com/badlogicgames/status/2107576417886011489

> tardigrade and pi durable both try to solve durable agent execution: an agent can crash and pick up where it left off. different designs for the same problem, each with its own tradeoffs.
>
> tardigrade derives everything from one event log. pi durable stores the transcript as plain https://t.co/VZAGHDeLYC

- Significance: Design contrast: Tardigrade derives all from one event log; pi durable stores the transcript plainly.
- Text source: _db.json; media on Will's box: 2107576417886011489_0.png

### Tue Oct 6, 2026, 2:05 PM PT (@badlogicgames)
Link: https://x.com/badlogicgames/status/2107577950766092541

> this one's from our own harness benchmark, outside of durable objects (also in the repo, see link at end of thread)
>
> the interesting bit for me is the middle chart. in tardigrade a single write gets more expensive the longer the conversation gets, because each commit re-derives https://t.co/6OQI6lhtja

- Significance: Harness benchmark outside Durable Objects; Tardigrade per-write cost grows with conversation length.
- Text source: _db.json; media on Will's box: 2107577950766092541_0.png

### Wed Oct 7, 2026, 11:44 AM PT (@badlogicgames)
Link: https://x.com/badlogicgames/status/2107904950453882934

> i haven't opened my laptop in days. i'm fully phone agent pilled. i can do anything i want, and the UI is exactly what i want and need, and not more. https://t.co/jEMrDgZQHj

- Significance: Hasn't opened his laptop in days; "fully phone agent pilled".
- Text source: _db.json; media on Will's box: 2107904950453882934_0.jpg

### Wed Oct 7, 2026, 12:37 PM PT (@badlogicgames)
Link: https://x.com/badlogicgames/status/2107918208816812335

> @fraserpricee what about it? https://t.co/CpIVR0ivYM

- Significance: Reply with video (content not reviewed here).
- Text source: _db.json; media on Will's box: 2107918208816812335_0.mp4

### Thu Oct 8, 2026, 6:45 AM PT (@badlogicgames)
Link: https://x.com/badlogicgames/status/2108192080073982301

> things durability can't fix. slopus, why you letting me down? and why does the status page say all is green? https://t.co/vPnzQhkVLg

- Significance: Model outage: durability can't fix provider failures.
- Text source: _db.json; media on Will's box: 2108192080073982301_0.jpg

### Sun Oct 11, 2026, 2:12 AM PT (@badlogicgames)
Link: https://x.com/badlogicgames/status/2109210439015862663

> hot reloadable, networked plugins have landed in pi-mobile. everything is a plugin now. if that sounds familiar, then yes, dsh and opencode also went that way. but ours are networked and multi-user/multi-surface aware, actually hot reload correctly, and participate in durabilitz

- Significance: PLUGINS: hot-reloadable, networked, multi-user/multi-surface plugins that participate in durability; "everything is a plugin now". Logs panel shows p2 / 127.0.0.1:8788 / ~/.pi/p2.
- Text source: verified via X API; media on Will's box: 2109210439015862663_0.jpg

### Sun Oct 11, 2026, 11:52 AM PT (@badlogicgames)
Link: https://x.com/badlogicgames/status/2109356595645976767

> it's a general networked app framework. it doesn't need to be agentic (but will be in 99% of our apps).

- Significance: The plugin host is a general networked app framework, not necessarily agentic.
- Text source: verified via X API

### Sun Oct 11, 2026, 12:45 PM PT (@badlogicgames)
Link: https://x.com/badlogicgames/status/2109369789042876886

> introducing chat mode :p
>
> much better than queuing. instead, mention the agent, and it gets a steering message with all the chat messages not delivered up until that point. https://t.co/G5xL4sw81q

- Significance: Chat mode: humans chat without waking the agent; mentioning the agent delivers a steering message with the undelivered chat backlog.
- Text source: _db.json; media on Will's box: 2109369789042876886_0.jpg, 2109369789042876886_1.jpg

### Sun Oct 11, 2026, 2:55 PM PT (@badlogicgames)
Link: https://x.com/badlogicgames/status/2109402647933702520

> durable codemode achieved internally. https://t.co/3KAXCVlGFE

- Significance: "Durable codemode achieved internally" - screenshot of the 12-step restart test script.
- Text source: _db.json; media on Will's box: 2109402647933702520_0.jpg

### Sun Oct 11, 2026, 3:17 PM PT (@badlogicgames)
Link: https://x.com/badlogicgames/status/2109408108896563242

> durable. love it. all these things just fall out of durable execution in pi durable. https://t.co/kJnfVUCdB5 https://t.co/OzVmnSVOZU

- Significance: VIDEO of the 12-step durable codemode restart test (archive mid-run, restore, call 3 interrupted, rest continue).
- Text source: _db.json; media on Will's box: 2109408108896563242_0.mp4

### Sun Oct 11, 2026, 3:40 PM PT (@badlogicgames)
Link: https://x.com/badlogicgames/status/2109413968552820840

> also cool: things like claude code's dynamic workflows fall out for free, durably :D
>
> and i can even inspect everything subagents of such a workflow do (or steer them if absolutely needed) https://t.co/g1ZiqJgEzn https://t.co/OzVmnSVham

- Significance: Codemode fans out one-shot subagent workflows (review/verify) durably; subagents inspectable and steerable.
- Text source: _db.json; media on Will's box: 2109413968552820840_0.mp4

### Sun Oct 11, 2026, 3:49 PM PT (@badlogicgames)
Link: https://x.com/badlogicgames/status/2109416099200565580

> @manojlds it already is. the only thing we haven't published yet is this app you see above built on pi durable. soon.

- Significance: Pi durable is already published; only the app built on it is unpublished - "soon".
- Text source: verified via X API

### Mon Oct 12, 2026, 1:29 AM PT (@badlogicgames)
Link: https://x.com/badlogicgames/status/2109562001550672164

> pressing F for maria. retrofitting a plugin system onto an existing app is pain. with and without agents. keeping that system stable is even worse pain.

- Significance: Plugin systems: retrofitting onto an existing app and keeping it stable is painful (quote of another dev).
- Text source: verified via X API

### Mon Oct 12, 2026, 2:00 AM PT (@badlogicgames)
Link: https://x.com/badlogicgames/status/2109569782936690834

> pi-ception. guess tuis are still useful https://t.co/cQ2NfhwX0J

- Significance: pi-ception: pi TUI inside p2's terminal plugin. Screenshot: 27 plugins / 20,415 TS lines; 58 tool calls in one codemode turn; host Linux 5.15 x86_64.
- Text source: _db.json; media on Will's box: 2109569782936690834_0.jpg, 2109569782936690834_1.jpg

### Mon Oct 12, 2026, 6:42 AM PT (@badlogicgames)
Link: https://x.com/badlogicgames/status/2109640873889906833

> @aaronyeeio see packages/chord in the pi repo. afraid it's a bit too much to explain in a tweet :)

- Significance: Points to packages/chord in the pi repo for the plugin/app framework.
- Text source: _db.json

### Mon Oct 12, 2026, 10:13 PM PT (@badlogicgames)
Link: https://x.com/badlogicgames/status/2109875071640895873
Context: reply about environment lifecycle in pi-durable

> not as a built-in but it should be easy to do this at the app level.

- Significance: Env lifecycle is not a pi-durable built-in; easy to do at the app level.
- Text source: verified via X API

### Tue Oct 13, 2026, 1:57 PM PT (@badlogicgames)
Link: https://x.com/badlogicgames/status/2110112810420351326

> how i use subagents 99.99% of the time. https://t.co/lItV0r1btZ

- Significance: How he uses subagents 99.99% of the time (screenshot; content not transcribed here).
- Text source: _db.json; media on Will's box: 2110112810420351326_0.jpg

### Fri Oct 16, 2026, 1:16 PM PT (@badlogicgames)
Link: https://x.com/badlogicgames/status/2111189600685207559

> so, i've been using this little shitty thing, running entirely on my phone except the llm calls, for almost 2 weeks for all my work.
>
> i've since rewritten it twice. also on the phone.
>
> never going back to anything else. https://t.co/mWoY6pipUd

- Significance: Daily driver for ~2 weeks for all work; rewritten twice, on the phone.
- Text source: _db.json

### Fri Oct 16, 2026, 1:19 PM PT (@badlogicgames)
Link: https://x.com/badlogicgames/status/2111190348244594811

> everything is phone https://t.co/jTJwmqfI5f

- Significance: "everything is phone" (screenshot).
- Text source: _db.json; media on Will's box: 2111190348244594811_0.jpg

### Fri Oct 16, 2026, 2:56 PM PT (@badlogicgames)
Link: https://x.com/badlogicgames/status/2111214825154179397
Context: reply to Q: what happens when you lock your phone during a long task

> keeps working, termux process is forcibly kept alive via a setting.

- Significance: Phone lock during long tasks: keeps working; Termux process forcibly kept alive via a setting.
- Text source: verified via X API

### Fri Oct 16, 2026, 11:22 PM PT (@badlogicgames)
Link: https://x.com/badlogicgames/status/2111342152513208371
Context: reply to Q about RAM / whether the phone is rooted

> pixel 11, not rooted, pi mobile takes a few hundred megs with many sessions running.

- Significance: Hardware: Pixel 11, not rooted; a few hundred MB RAM with many sessions.
- Text source: verified via X API

### Sat Oct 17, 2026, 12:58 AM PT (@badlogicgames)
Link: https://x.com/badlogicgames/status/2111366160205987847
Context: reply to @rcarmo asking whether it no longer runs in Termux

> i just ripped the parts from termux i need and built a bespoke simple android app.

- Significance: Native app = parts ripped from Termux + bespoke simple Android app.
- Text source: verified via X API

### Sat Oct 17, 2026, 1:12 AM PT (@badlogicgames)
Link: https://x.com/badlogicgames/status/2111369852111786259
Context: reply to Q asking for a throwaway repo

> it's not in a good state :D just point your agent at termux repo and say: i just need the usrrland emu and the background process stuff so my shit doesn't die.

- Significance: Code "not in a good state"; ADVICE: point your agent at the Termux repo and take only userland emulation + background-process keep-alive.
- Text source: verified via X API

### Sat Oct 17, 2026, 4:10 AM PT (@badlogicgames)
Link: https://x.com/badlogicgames/status/2111414588642070739

> built a walkthrough agent for the team, teaching them how the new plugin system works via walkthroughs/questions. opus 5.5. has access to a prebaked walkthrough.md and all sources.
>
> testing it to feel the agi, context at 10%, so 100k tokens (.md plus most of the sources) https://t.co/49irYi74ir

- Significance: Walkthrough agent (Opus 5.5) teaching his team the new plugin system from a walkthrough.md + sources (~100k tokens).
- Text source: _db.json; media on Will's box: 2111414588642070739_0.jpg

### Sat Oct 17, 2026, 4:26 AM PT (@viticci (retweeted by Mario))
Link: https://x.com/viticci/status/2111418614343504107

> One week of progress on my 'Apple Bots' app based on @badlogicgames' Pi Durable, in Swift. We got:
>
> - Support for 20+ Apple frameworks (including Music playback and agent Shazam)
> - Voice mode that works in the background (either GPT-Live or Grok Voice)
> - Background tasks
> - WebKit browser use 
> - Create your own mini web apps 
> - Native subagents 
> - Memories and session recall 
>
> And so much more. I'm genuinely making the agent app of my dreams for Apple platforms.
>
> Stay tuned here for lots more soon 🤖

- Significance: Context (RT of @viticci, not Mario): 'Apple Bots' Swift app on Pi Durable - 20+ Apple frameworks, background voice, background tasks, WebKit browser use.
- Text source: _db.json

### Mon Oct 19, 2026, 12:38 AM PT (@badlogicgames)
Link: https://x.com/badlogicgames/status/2112085863408812097

> holy cow, codemode. https://t.co/h0L4GFSgP2

- Significance: "phone dev" session: p2 on phone, tools on slayer; audio generated on slayer, moved in 45 KB chunks via codemode into a phone-side artifact under ~/.pi/p2.
- Text source: _db.json; media on Will's box: 2112085863408812097_0.jpg

### Mon Oct 19, 2026, 1:03 AM PT (@badlogicgames)
Link: https://x.com/badlogicgames/status/2112092325237145858
Context: reply to Q "Slayer is your remote session in hetzner vm?"

> no, just a remote execution env i can switch my phone agent too.

- Significance: Slayer clarified: "just a remote execution env" his phone agent switches to (answer to whether it is his remote session in a Hetzner VM: "no").
- Text source: verified via X API

### Mon Oct 19, 2026, 1:40 AM PT (@badlogicgames)
Link: https://x.com/badlogicgames/status/2112101503938777464

> building software in my car with voice mode (still working on latency) https://t.co/s4Luv9TFZ6

- Significance: Voice mode while driving (latency WIP); TTS benchmarking on slayer per HANDOFF.
- Text source: _db.json; media on Will's box: 2112101503938777464_0.mp4

### Mon Oct 19, 2026, 2:51 AM PT (@badlogicgames)
Link: https://x.com/badlogicgames/status/2112119334046667011

> @_can1357 no fucking sucks. parakeet on my hetzner.

- Significance: STT: parakeet runs on "my hetzner" (distinct from slayer).
- Text source: _db.json

### Mon Oct 19, 2026, 5:18 PM PT (@badlogicgames)
Link: https://x.com/badlogicgames/status/2112337657430933694

> @mattzcarey also https://t.co/TzrH3dg8QR

- Significance: Reply to @mattzcarey with an image (content not transcribed here).
- Text source: _db.json; media on Will's box: 2112337657430933694_0.png

### Mon Oct 19, 2026, 5:25 PM PT (@badlogicgames)
Link: https://x.com/badlogicgames/status/2112339320107364370

> both are on main, enjoy.
>
> tools will be hibernatable soon too. https://t.co/3v1UHeNrEQ

- Significance: pi durable main: hibernation + telemetry landed; tools to become hibernatable soon.
- Text source: _db.json

---

## 3. Architecture as observed

**Runtime on the phone**
- Started Oct 2-3 in **Termux** (Linux userland app for Android): Node server on `127.0.0.1:8787`, exposed publicly via **ngrok** (`pim.ngrok.pro`) [media 2106383122183196709, 2107238740230078520]. By Oct 11 the app is called **p2**: server `127.0.0.1:8788`, data dir `~/.pi/p2` [media 2109210439015862663]. (SPEC note: the Oct 11-12 p2 dev instance in screenshots showed `/home/badlogic/.pi/p2` on Linux x86_64, i.e. it was running **on slayer** at that point [inferred from paths]; by Oct 19 p2 runs on the phone [media 2112085863408812097].)
- **Native Android app** (Oct 4): package `works.earendil.pi.mobile` (per HANDOFF), built from Termux's **userland emulation** plus its **background-process keep-alive**, runs as an Android **foreground service** ("it's a foreground service. since it's mostly waiting for llm reponses, it also barely costs any battery") [Mario, 2106485523317489902], with a **WebView UI** (per HANDOFF) [inferred detail: the WebView presumably loads the same web UI the server serves]. Few hundred MB RAM [Mario].
- Keep-alive under screen lock: "termux process is forcibly kept alive via a setting" [Mario, Oct 16]; which setting is not stated.
- Durability: the OS can kill the process; it respawns and continues where it left off [Mario, 2106354140343603217]. 24 h on battery [Mario, 2106440272427016278].

**Process model: Chord server + worker per session**
- Mario: "server/session workers > kill amd respawn, pi durable takes care of the rest" [2106387323390960086]. Archive = SIGTERM to that session's worker (graceful Harness close, hard kill after ≤1.5 s) [media, restart test]. One worker per session is [inferred] from this.
- Substrate is **Chord** (`packages/chord` in the pi monorepo, npm `@earendil-works/chord`): Mario pointed to it for the plugin framework [Mario, 2109640873889906833]; a sidebar session is titled "Rebuild Pi Mobile on chord2 as p…" [media]. Chord provides server + session-worker hosts, owner/guest principals, WebSocket/IPC links, plugin facets (server/worker/web), cross-host hot reload, Durable integration [source reading in SPEC]. That p2 uses Chord this way is [inferred], strongly supported.
- Self-editing: web UI via Vite HMR; server/worker code changes trigger a "Server code changed · Restart" banner, workers respawn and durability restores them [Mario + media].

**Execution environments (env switching)**
- Phone-local tools first (bash/edit/git in Termux paths `/data/data/com.termux/files/home/...`), then switch to a remote env over SSH mid-session; the brain stays on the phone [Mario/media, Oct 5].
- **`env:path` cwd display**: the header, sidebar groups, new-session picker and Session sheet show the working directory as `env:path`, e.g. `slayer:/home/badlogic/pi-mono`; sidebar groups in the Oct 5 screenshot: `slayer:/home/badlogic/pi-mono`, `~/pi`, `~/pi-mobile`, `~/journal` (unprefixed = phone-local [inferred]) [media 2107238740230078520].
- An **"Envs"** tab in the sidebar footer (alongside Archived, Providers, Devices, theme) [media].
- Env lifecycle (e.g. starting/stopping envs) is not a pi-durable built-in; "easy to do this at the app level" [Mario, 2109875071640895873].

**Artifacts**: an `artifact` tool stores files on the phone under `~/.pi/p2`. Remote files reach the phone only through tool output (the 45 KB-chunk trick on Oct 19) [media 2112085863408812097]. Artifacts were added Oct 3 [Mario, 2106452296087302173].

**Plugins** (Oct 11): "hot reloadable, networked plugins ... everything is a plugin now ... networked and multi-user/multi-surface aware, actually hot reload correctly, and participate in durabilitz" [Mario]. Oct 12 screenshot: **27 plugins / 20,415 lines of TypeScript**; largest: terminals 3,493, workspace 1,999, models 1,937, envs 1,706, chat 1,650 [media 2109569782936690834, via HANDOFF]. Size was ~12k LOC (6k frontend) on Oct 5 [Mario]. It is "a general networked app framework" that need not be agentic [Mario].

**UI features seen**: sessions sidebar with search; composer with model chip, Steer, queued follow-ups; status footer (model · thinking, participants, cache-hit "chr", session cost, context used e.g. "16%/1.00M"); right panel Files / Changes (git diff) / Search / Comments / Terminal (with extra-keys row; ran the pi TUI inside p2, "pi-ception"); logs panel; providers screen; cost panel; paged transcript loading; codemode blocks with per-call status (green check done, spinner running, red ! interrupted); chat mode (humans chat without waking the agent; `@` mention delivers the chat backlog as a steering message); agent-to-agent messaging and background subagents; codemode-driven one-shot reviewer/verifier subagent workflows [Mario/media/video].

**Clients connect to the phone**: an Android tablet browser connects to the phone ("agents run on my phone, tablet connects to it") [Mario/media 2107231693568438767]; multiplayer guests join via the ngrok URL (Armin Ronacher shown steering, ~130 viewers at peak) [Mario]. **Correction**: HANDOFF also cited a Mac client (2107508318688235798), but that screenshot is Armin running *his own copy* on his Mac, not a Mac connected to Mario's phone. A Mac browser connecting to the phone is plausible via the same ngrok URL but not shown [inferred].

**Tunnel**: ngrok (`pim.ngrok.pro`) from Oct 3 through at least Oct 19 (URL bar in the Oct 19 screenshot) [media].

**Models/providers seen**: Claude Opus 5.5 (high), GPT-6.1 Sol / gpt-5.6-sol, Haiku 4.5; providers incl. OpenRouter, Radius, Together, Vercel AI Gateway, xAI, Xiaomi [media, via HANDOFF].

---

## 4. Tool routing: phone vs Slayer

**Observed** (directly in posts/screenshots/video):
- The agent loop runs on the phone; LLM calls go out to providers; nothing else leaves the phone by default [Mario].
- In one session the agent's tools moved from the phone to slayer; the model reported running "over SSH on slayer", and the UI cwd became `slayer:/home/badlogic/pi-mono` [media, Oct 5].
- Oct 11 restart test: codemode script ran on the phone side; its `tools.bash` calls executed on slayer (`/tmp/durable-codemode/restart.log`) [media/video].
- Oct 11 workflow video: tools ran in Termux on the phone, so phone-local tools were still used alongside slayer [video 2109413968552820840].
- Oct 19 "phone dev": session in p2 on the phone, tools on slayer; Python/audio generation on slayer; file content returned to the phone only as tool output, saved by the phone-side `artifact` tool [media].
- Voice: TTS benchmarking (Qwen3-TTS on CPU) on slayer (per HANDOFF); parakeet STT "on my hetzner" [Mario].

**Inferred** (not stated by Mario):
- [inferred] The remote env is pi-env (`@earendil-works/pi-env`): SSH from the phone, a small daemon auto-deployed to the remote (`~/.pi/mobile/tools/`), framed protocol over the SSH pipe. Basis: pi-env's code uses the same `~/.pi/mobile` paths, a per-env known_hosts file and a fixed `pi-env-<name>` host-key alias, matching `HostKeyAlias=pi-env-slayer` in his bench script.
- [inferred] The env choice is per-session app state (a doc next to the transcript) and the env object is resolved at each tool call (pi-durable's `env: ({conversationId, cwd}) => ExecutionEnv` hook).
- [inferred] There is no file sync between envs; cross-env data moves through tool output (hence the 45 KB chunk trick).
- Unknown: how he handles a switch while a tool is in flight, and whether cwd is remembered per env.

**How Will's SPEC maps this to `aitc-laptop` (SPEC §3.3 summary)**:
- **Env registry** in config: `phone` (kind `local`, defaultCwd `~`) and `aitc-laptop` (kind `ssh`, host `aitc-laptop`, user `will`, defaultCwd `~/work`, loginShell). More envs = more entries.
- **`app.env` doc** per conversation: `{ active, cwd: { phone: ..., "aitc-laptop": ... }, pending? }`. The `env()` hook returns `LocalExecutionEnv` (phone) or `RemoteExecutionEnv` over a pooled, lazy `sshConnection({host, user, identityFile, knownHostsFile, hostKeyAlias: "pi-env-aitc-laptop"})`. An offline laptop only fails calls that need it.
- **Per-env cwd** memory; an env section in the system prompt (`env: aitc-laptop (Linux x86_64), cwd: ..., home: ...`) recorded at its position in the transcript; the switch entry warns that paths from the other env are invalid.
- **Switch** via UI, `/env <name>`, or a model-callable tool: one commit sets `app.env.active`, writes a visible `app.env-switch {from, to, cwd}` entry, and reconfigures cwd.
- **Switch at turn boundaries only** (so one codemode script never spans two hosts). If busy, the switch is stored as **`app.env.pending`** and applied before the next model request; a "switch now" option aborts the run first.
- **Connect-retry wrapper**: retries only **`spawn_error`** (the command never started); a **lost** in-flight command is never retried.
- **In-flight tool at switch time finishes on its old env** (keeps its env object and connection); the pending switch applies afterward.
- Also: `env_copy` tool (host-side streamed copy with SHA-256 verify) replaces Mario's chunk trick; artifacts always stored on the phone; one terminal per env; Termux `/tmp` → `${TMPDIR:-/tmp}`.
- Reaching the laptop: Termux `ssh` over Tailscale MagicDNS, key-only OpenSSH, no ngrok.

---

## 5. Unknowns / open questions

From HANDOFF (unknowns) and SPEC (§1.7, §7):
- No automated kill loop or kill rate shown by Mario (only manual archive/restore); no dashboard.
- What services/containers run on slayer beyond the remote env (Docker is present per his bench script).
- p2 source is private; internals are reconstructed from screenshots.
- Slayer vs Hetzner ambiguity (Oct 5 text says "my hetzner", screenshot shows slayer; Oct 19 he says slayer is not his Hetzner session, and parakeet is on "my hetzner").
- Tunnel still ngrok as of Oct 19; no tailnet setup shown.
- Process layout beyond "server/session workers" (one worker per session is inferred).
- Guest authentication and what guest modes may do (Chord has `view` / `full`); Mario calls multiplayer security "a challenge".
- How an env switch is handled while a run is in flight; whether cwd is kept per env.
- Native app keep-alive details and which Termux "setting" keeps the process alive; whether his daily driver is the native app or Termux by Oct 19.
- Whether the slayer SSH key/known_hosts/alias in his bench script are exactly what p2 uses (likely, not confirmed).
- Release: "soon" (Oct 11) with no date; nothing published as of Oct 20.

---

## 6. How this relates to Will's build

- Will's implementation: repo **`Whamp/pi-mobile`**, branch **`feat/p2w-android`**, draft PR **https://github.com/Whamp/pi-mobile/pull/1**. This document lives in that branch at `docs/research/mario-pi-android-x-bundle.md`.
- Debug APK (built on Will's box, not in the repo): `/workspace/badlogic-torture/apk/p2w-debug.apk` (universal arm64-v8a + x86_64, package `dev.whamp.p2w`, Android 15+, debug-signed; there is also `p2w-debug-x86_64-emulator.apk`, unsuitable for the phone). Per `android/README.md` and the PR body: a `specialUse` foreground service owns a persistent notification, partial wake lock and the Node process (bundled Termux-built Node 24); the Activity only hosts a WebView; server on `127.0.0.1:18787`; the `bash` tool runs Android `/system/bin/sh` + toybox, so **GNU bash, coreutils, Git and npm are NOT bundled in the APK**. PR is still draft; native on-device agent execution and recovery were not yet proven (host/web twelve-step tests pass P1-P4).
- Difference from Mario: his native app carries Termux's userland emulation (so, presumably, a full Linux userland with packages [inferred]); Will's APK currently does not, it uses Android's shell/toybox. If you need Mario's capability, his advice applies: port Termux's userland emulation + background-process keep-alive [Mario, 2111369852111786259].
- The repo README describes it as a "lightweight, mobile-first host for Pi Durable, running in Termux", with a React/Vite browser UI, independent session workers, shared config resources, and localhost provider login. Deps pinned to `@earendil-works/pi-durable`, `chord`, `pi-ai`, `pi-codemode` 1.3.0; Node ≥ 22.19.
- **In-phone dev path** (same self-editing loop Mario uses; use Termux, not the APK, because the APK has no npm/git): run in **Termux** with **`npm run dev`** (`scripts/dev.mjs`, a supervisor outside the server and workers). Frontend edits hot-reload via **Vite HMR**; edits under `src/server/`, `src/shared/`, `src/worker/` (coalesced 500 ms) **recycle the backend and resume every previously running worker from Durable state**. Manual restart: `kill -USR2 "$PI_MOBILE_DEV_SUPERVISOR_PID"`. Changes to the supervisor, package/dependency config or startup env need relaunching `npm run dev`. Unsafe tools interrupted mid-execution are not blindly replayed. See `DEV.md` / `README.md` in the repo.
- Checks before committing (pre-commit hook): `npm run check` (Biome via WASM + `tsc --noEmit`) and `npm test`.
- Mapping Mario → Will: phone brain = same; slayer → **aitc-laptop** (SSH over Tailscale, not ngrok); 45 KB chunk artifacts → `env_copy`; his native app → Will's `android/` app on this branch (foreground service + WebView, toybox shell, no Termux userland yet).
