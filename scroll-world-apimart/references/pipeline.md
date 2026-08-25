# Pipeline: copy-paste scripts (bash 3.2 safe, curl + jq only)

Set these once. `NAMES` is the ordered section ids; the last is the hero/finale.

```bash
WORK=/tmp/scroll-world           # scratch dir for prompts, sources, frames
ASSETS=./assets                  # where the site reads stills (webp) + clips (mp4)
mkdir -p "$WORK" "$ASSETS/vid"
NAMES="farm kitchen shop delivery plaza finale"   # <-- your section ids, in order

API=https://api.apimart.ai
AUTH="Authorization: Bearer $APIMART_API_KEY"     # export APIMART_API_KEY first

# Chain video model — ONE for every chained clip (SKILL Step 4 roster).
# Must accept image_with_roles first_frame AND last_frame:
# doubao-seedance-2.0 | doubao-seedance-2.0-fast | doubao-seedance-2.0-mini | kling-v3-omni.
# Reference-only models can't hold a seam.
VMODEL=doubao-seedance-2.0
case "$VMODEL" in                                  # per-model params + durations (bash 3.2 safe)
  doubao-seedance-2.0-mini) VRES=720p;  DIVE_DUR=8;  CONN_DUR=5 ;;  # cheap frame-locked previz
  kling-v3-omni)            VRES="";    DIVE_DUR=10; CONN_DUR=5 ;;  # check current param set in docs
  *)                        VRES=1080p; DIVE_DUR=8;  CONN_DUR=5 ;;  # seedance 2.0 / 2.0-fast default
esac
IMODEL=flux-2-pro                # stills: flux-2-pro (default) | z-image-turbo (draft) | gemini-3-pro-image-preview
```

## 0. Core helpers — submit / poll / upload

Everything on APIMart is **async**: POST returns a `task_id`, you poll
`GET /v1/tasks/{task_id}` every 5 s, and you download the result URL **immediately**
(generated URLs expire — images ~24 h, videos per `expires_at`, uploads 72 h).
Generations take minutes — run the batch scripts below **backgrounded** and poll the
progress log; never block the foreground.

```bash
am_submit() { # endpoint json-body -> task_id (empty on failure)
  curl -fsSL -X POST "$API/$1" -H "$AUTH" -H 'Content-Type: application/json' \
    -d "$2" | jq -r '(.data[0].task_id // .data.task_id // .task_id) // empty'
}

am_poll() { # task_id [timeout_s] -> result asset url (video or image)
  t=0; max=${2:-1800}
  while [ "$t" -lt "$max" ]; do
    j=$(curl -fsSL "$API/v1/tasks/$1" -H "$AUTH")
    st=$(printf '%s' "$j" | jq -r '.data.status // .status // empty')
    if [ "$st" = "completed" ]; then
      printf '%s' "$j" | jq -r '.data.result.videos[0].url[0] // .data.result.videos[0].url
        // .data.result.images[0].url[0] // .data.result.images[0].url
        // .data.url // .data.result.url // empty'
      return 0
    fi
    if [ "$st" = "failed" ]; then printf '%s\n' "$j" >&2; return 1; fi
    sleep 5; t=$((t+5))
  done
  echo "poll timeout for $1" >&2; return 1
}

am_task_json() { # task_id -> full task JSON (for cost fields, last_frame url, fail reason)
  curl -fsSL "$API/v1/tasks/$1" -H "$AUTH"
}

am_upload() { # local-image-file -> url (valid 72h; jpeg/png/webp/gif, <=20MB)
  curl -fsSL -X POST "$API/v1/uploads/images" -H "$AUTH" -F "file=@$1" | jq -r '.url // empty'
}
```

**Calibrate cost before the full run (SKILL Step 1.6):** after ONE still and ONE video
complete, `am_task_json <id> | jq '.data.cost, .data.credits_cost'` gives the real
charge per task — extrapolate `N × still + (2N−1) × video × [2 if mobile] × 1.15` and
state it to the user before batching.

## 1. Scene stills (Step 2)

Write one prompt file per section to `$WORK/still_<name>.txt` (see prompts.md), then:

```bash
gen_still() { # name
  case "$IMODEL" in
    z-image-turbo) body=$(jq -n --arg m "$IMODEL" --arg p "$(cat "$WORK/still_$1.txt")" \
                     '{model:$m, prompt:$p, size:"3:2", resolution:"2K"}') ;;
    flux-2-pro)    body=$(jq -n --arg m "$IMODEL" --arg p "$(cat "$WORK/still_$1.txt")" \
                     '{model:$m, prompt:$p, size:"3:2", resolution:"2MP"}') ;;
    *)             body=$(jq -n --arg m "$IMODEL" --arg p "$(cat "$WORK/still_$1.txt")" \
                     '{model:$m, prompt:$p, size:"3:2", resolution:"2K", n:1}') ;;  # gemini/nano-banana: probe 3:2 first
  esac
  tid=$(am_submit v1/images/generations "$body")
  [ -n "$tid" ] || { echo "still $1 SUBMIT FAIL"; return 1; }
  url=$(am_poll "$tid" 900) && curl -fsSL "$url" -o "$WORK/still_$1.png" \
    && echo "still $1 ok" || echo "still $1 FAIL (task $tid)"
}
for n in $NAMES; do gen_still "$n" & done ; wait
```

Codex variant (STILLS_SOURCE=codex, SKILL Step 1.6 — subscription-billed, zero APIMart
spend; ~1–3 min each, parallelize in small batches):

```bash
gen_still_codex() { # name
  codex exec -C "$WORK" -s workspace-write --skip-git-repo-check \
    'Use the image generation tool ($imagegen) to generate: '"$(cat "$WORK/still_$1.txt")"' Wide 3:2 landscape, high resolution. Save it as ./still_'"$1"'.png. Do not do anything else.' \
    > "$WORK/still_$1.codex.log" 2>&1
  [ -f "$WORK/still_$1.png" ] && echo "still $1 ok (codex)" || echo "still $1 FAIL (see .codex.log)"
}
```

Convert to webp for the site (and optionally run knockout.py first for transparency):

```bash
for n in $NAMES; do cwebp -quiet -q 84 -resize 1800 0 "$WORK/still_$n.png" -o "$ASSETS/$n.webp"; done
```

Review the stills for cohesion before continuing. Re-roll any off-style one (optionally
adding an approved scene's URL to `image_urls` to lock style — upload it first with
`am_upload`).

## 2. Dive-in clips (Step 4)

Prompt files at `$WORK/dive_<name>.txt`. First frame = the solid-bg still PNG, uploaded.
`return_last_frame:true` makes Seedance hand back the actual last-frame URL — saved per
dive for the connectors (§3/§4).

```bash
gen_dive() { # name
  iurl=$(am_upload "$WORK/still_$1.png")
  [ -n "$iurl" ] || { echo "dive $1 UPLOAD FAIL"; return 1; }
  body=$(jq -n --arg m "$VMODEL" --arg p "$(cat "$WORK/dive_$1.txt")" --arg u "$iurl" \
    --arg r "$VRES" --argjson d "$DIVE_DUR" \
    '{model:$m, prompt:$p, image_with_roles:[{url:$u, role:"first_frame"}],
      size:"16:9", duration:$d, generate_audio:false, return_last_frame:true}
     + (if $r != "" then {resolution:$r} else {} end)')
  tid=$(am_submit v1/videos/generations "$body")
  [ -n "$tid" ] || { echo "dive $1 SUBMIT FAIL"; return 1; }
  url=$(am_poll "$tid" 1800) || { echo "dive $1 FAIL (task $tid)"; return 1; }
  curl -fsSL "$url" -o "$WORK/dive_$1.mp4"
  am_task_json "$tid" > "$WORK/dive_$1.task.json"   # keeps cost + last_frame url
  echo "dive $1 ok"
}
for n in $NAMES; do gen_dive "$n" & done ; wait
```

Re-roll individual failures (429 / 5xx are transient; 402 = top up balance):
`gen_dive shop`  (just that one).

## 3. Extract boundary frames — the seam handoff (Step 5)

For each adjacent pair, the connector's first_frame = dive_i's LAST frame, last_frame =
dive_{i+1}'s FIRST frame — from the **rendered videos**, never the stills. Extract
locally in every case (you must eyeball the handoffs, SKILL Step 4), even when the
`return_last_frame` URL will be what you actually submit:

```bash
set -- $NAMES
for n in "$@"; do
  ffmpeg -v error -ss 0 -i "$WORK/dive_$n.mp4" -frames:v 1 -q:v 2 "$WORK/first_$n.png"      # establishing
  ffmpeg -v error -sseof -0.15 -i "$WORK/dive_$n.mp4" -frames:v 1 -q:v 2 "$WORK/last_$n.png" # interior
done
```

## 4. Connector clips (Step 5)

Prompt files at `$WORK/conn_<i>.txt` (i = 1..N-1). Both endpoints go up via `am_upload`
(72 h validity — regenerate the upload if a run stalls past that). If a dive's
`.task.json` carries a still-valid `last_frame` URL you may use it directly as that
connector's first_frame and skip one upload — the extracted PNG is the safe default.

```bash
gen_conn() { # i startPng endPng          (last_frame role required -> roster models only)
  su=$(am_upload "$2"); eu=$(am_upload "$3")
  [ -n "$su" ] && [ -n "$eu" ] || { echo "conn $1 UPLOAD FAIL"; return 1; }
  body=$(jq -n --arg m "$VMODEL" --arg p "$(cat "$WORK/conn_$1.txt")" \
    --arg su "$su" --arg eu "$eu" --arg r "$VRES" --argjson d "$CONN_DUR" \
    '{model:$m, prompt:$p,
      image_with_roles:[{url:$su, role:"first_frame"},{url:$eu, role:"last_frame"}],
      size:"16:9", duration:$d, generate_audio:false}
     + (if $r != "" then {resolution:$r} else {} end)')
  tid=$(am_submit v1/videos/generations "$body")
  [ -n "$tid" ] || { echo "conn $1 SUBMIT FAIL"; return 1; }
  url=$(am_poll "$tid" 1800) && curl -fsSL "$url" -o "$WORK/conn_$1.mp4" \
    && echo "conn $1 ok" || echo "conn $1 FAIL (task $tid)"
}
set -- $NAMES ; i=0 ; prev=""
for n in "$@"; do
  if [ -n "$prev" ]; then i=$((i+1)); gen_conn "$i" "$WORK/last_$prev.png" "$WORK/first_$n.png" & fi
  prev="$n"
done ; wait
```

## 5. Encode everything for scrubbing (Step 6)

Native resolution (1080p from seedance 2.0; whatever ffprobe reports on other models —
never upscale), crf 20, GOP 8, light sharpen, no audio, faststart. Same for dives +
connectors.

```bash
enc() { ffmpeg -v error -y -i "$1" -an -vf "unsharp=5:5:0.8:5:5:0.0" \
  -c:v libx264 -preset slow -crf 20 -pix_fmt yuv420p \
  -g 8 -keyint_min 8 -sc_threshold 0 -movflags +faststart "$2"; echo "enc $2 $(du -h "$2"|cut -f1)"; }

for n in $NAMES; do enc "$WORK/dive_$n.mp4" "$ASSETS/vid/$n.mp4"; done
i=0; for f in "$WORK"/conn_*.mp4; do i=$((i+1)); enc "$f" "$ASSETS/vid/conn$i.mp4"; done
```

Now the engine config's `sections[k].clip = assets/vid/<name>.mp4` and
`connectors = [assets/vid/conn1.mp4, …]` (length N-1, in order).

## 6. Centre-crop mobile encodes — FALLBACK ONLY, not the mobile version

**The mobile version is the native 9:16 portrait chain (§6b).** This section's crop
encodes exist for one case: the user opted into mobile but the budget can't cover the
portrait chain — and shipping them must be called out and approved, never silent
(portrait phones will see the landscape film's centre ~26%). The encode mechanics
matter either way: scrubbing sets `currentTime` every frame, and a phone decoder's
**seek cost scales with how many frames it must decode from the nearest keyframe** — so
a 1080p `-g 8` master that scrubs fine on a laptop stutters on a phone. A **smaller
frame + tighter GOP** fixes that (and halves the bytes on cellular). The crop `-m.mp4`
sibling per clip:

```bash
# 720p, GOP 4 (twice the keyframes = ~half the seek-decode work), crf 23, same sharpen/faststart.
encm() { ffmpeg -v error -y -i "$1" -an -vf "scale=-2:720,unsharp=5:5:0.6:5:5:0.0" \
  -c:v libx264 -preset slow -crf 23 -pix_fmt yuv420p \
  -g 4 -keyint_min 4 -sc_threshold 0 -movflags +faststart "$2"; echo "encm $2 $(du -h "$2"|cut -f1)"; }

for n in $NAMES; do encm "$WORK/dive_$n.mp4" "$ASSETS/vid/$n-m.mp4"; done
i=0; for f in "$WORK"/conn_*.mp4; do i=$((i+1)); encm "$f" "$ASSETS/vid/conn$i-m.mp4"; done
```

Wire the variants in the engine config — the engine serves them automatically on phones,
falling back to the desktop `clip` when a mobile one is absent:

```js
sections[k].clipMobile = 'assets/vid/<name>-m.mp4';
connectorsMobile = ['assets/vid/conn1-m.mp4', …];   // length N-1, in order
```

If phone scrubbing still stutters, tighten the GOP further (`-g 2`, or `-g 1` for all-intra
= instant seeks at the cost of larger files); if cellular weight is the bigger worry, raise
`crf` (24–26) or drop to `scale=-2:600`. If the master is 720p (mini tier), the mobile
encode still pays off — the tighter GOP is what makes phone seeks cheap. All §6 encodes
stay 16:9 — the engine centre-crops them; see the portrait note in SKILL Step 8 / prompts.md.

## 6b. Native 9:16 portrait chain — THE mobile version (Step 1.5 opt-in)

When the user opts into mobile, this is what they get: a **parallel 9:16 chain** rendered
natively for phones and shipped as the mobile variants — never the §6 crops (those are the
no-budget stopgap). Same seam laws as the main chain — the portrait chain frame-locks
against its own rendered frames, never the landscape ones. Budget ~2N-1 video gens +
re-rolls (interiors trip the content filter in portrait too); state the cost at the
Step 1.5 interview.

1. **Portrait start canvases.** Don't hand the video model a 3:2 still and hope: composite
   each scene onto a 1080×1920 canvas in the page bg colour (island at ~94% width, visual
   centre at ~45% height). The render then opens exactly on what the portrait poster shows.
   For knocked-out stills, composite the RGBA over the bg colour first.
2. **Dives/legs**: same prompt templates with a portrait clause up front ("Vertical
   portrait composition, the diorama centered with generous [bg] space above and below"),
   `size: "9:16"`, same model/params as the main chain. Review each last frame
   before chaining, as ever.
3. **Connectors**: extract first/last frames **from the 9:16 renders** and generate 9:16
   connectors between them. A native 9:16 scene mixed into cropped-16:9 neighbours pops at
   both seams — the portrait chain must be complete, not partial.
4. **Encode** with the §6 settings but portrait-oriented scale: `scale=720:-2` (720 wide),
   `-g 4`, crf 23 → these ARE the `-m.mp4` mobile files (and they replace any §6 crop
   stopgaps that shipped earlier).
5. **Posters**: extract each 9:16 dive's first frame → webp → wire as the section's
   `stillMobile` so the poster matches the portrait video's frame 0 (no landscape→portrait
   flash when the clip paints). Engine support: `sections[k].stillMobile`.

## Notes

- **Response-shape drift**: the docs show slightly different task payloads per model
  (`.data.result.videos[0].url[0]`, `.data.url`, …). `am_poll` tries the known shapes;
  if a new model returns something else, `am_task_json <tid> | jq .` once and extend the
  jq path — don't guess.
- **Moderation fallback across models**: if one clip keeps getting flagged on seedance
  after re-rolls + prompt scrubbing, regenerate just that clip on `kling-v3-omni` with
  the SAME first/last frame URLs (`VMODEL=kling-v3-omni; VRES=""; gen_conn 3 …`) — then
  restore your chain model. See SKILL Gotchas for the trade-off.
- **Previz on the cheap**: run the whole chain once with `VMODEL=doubao-seedance-2.0-mini`
  (frame-locking intact, 720p) to validate the journey and seams before spending
  full-model money — same model family, so the previz translates directly to the final
  render. Don't reach for reference-only models here: without first/last-frame roles
  they can't hold a seam, so their output can't be chained (Step 4 rule).
- If a whole batch stalls, check the `.task.json` / stderr dumps for the reason
  (`fail_reason`, 402 balance, 429 rate limit).
- Concurrency: launching ~5–6 gens at once is fine; much more invites 429s — stagger
  or re-roll.
- Costs: every completed task's JSON carries `cost` / `credits_cost` — sum them as you
  go so the user can see actual spend vs. the Step 1.6 estimate.
