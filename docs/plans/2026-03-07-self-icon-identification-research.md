# Research Report: Local Player Icon Identification on the Minimap

**Date:** 2026-03-07
**Status:** Research complete, awaiting approach selection

## Problem Statement

We can detect champion icon borders on the minimap as blobs (teal rings = allies, red rings = enemies) with good accuracy and minimal false positives. However, we need to identify **which teal blob is the local player's champion** to report our position for proximity voice calculations.

Currently, the app picks the highest-scoring teal ring blob (by `pixels * (1 - fillRatio)`), which works at fountain start but becomes unreliable when multiple allies are visible. With up to 5 ally icons plus occasional false positives from minion clusters, we need a robust identification method.

**What we know at detection time:**
- Blob data: center (cx,cy), bounding box, pixel count, fillRatio, border color
- Local player's champion name (from GEP/live_client_data API)
- Screen resolution, minimap scale, minimap region bounds
- ~8fps capture rate, ~20-30px icon diameter

**What we do NOT have:**
- Player map coordinates from any API (confirmed: Riot does not expose this)
- Any visual indicator distinguishing the local player's icon from other allies (no arrow/chevron)

---

## Key Finding: No API-Based Position Data Exists

Research confirms that **neither Overwolf GEP nor the Riot Live Client Data API provides player map coordinates**. The `position` field in player data refers to lane role assignment (TOP, MID, etc.), not x/y coordinates. This is intentional for competitive integrity. Computer vision on the minimap is the only ToS-compliant method for position tracking.

---

## Approach 0: Movement Path Line Detection (RECOMMENDED - Primary)

### Concept
When the local player right-clicks to move, League draws a **thin white line on the minimap** from the champion's current position to the movement destination. This line is **only visible for the local player** — other allies' movement paths are not shown. Any teal blob that has a white line emanating from it is guaranteed to be the local player.

### How It Works
1. Add white pixel detection to existing color classifier: `r > 200 && g > 200 && b > 200`
2. For each teal blob, count white pixels within or immediately adjacent to its bounding box (expand bbox by a few pixels)
3. A "burst" of white pixels near a teal blob during movement indicates the local player
4. Once identified, switch to position-continuity tracking (LOCKED state)

### Strengths
- **Unambiguous:** Only the local player's icon has the movement path line
- No template images or champion-specific data needed
- Uses the same color filtering pipeline already in place
- Works regardless of camera mode (locked/unlocked)
- Simpler than viewport rectangle detection (no shape parsing needed)
- Very frequent signal: players click to move constantly

### Weaknesses
- Only visible during active movement (not when standing still in base)
- Pings and other white minimap elements could create false signals
- Line may be very brief (need to catch it within a frame or two)
- Need to characterize exact pixel properties (screenshots needed for calibration)

### Detection Strategy
- Expand each teal blob's bounding box by ~5px in all directions
- Count white pixels in the expanded region but outside the icon border
- A teal blob with significantly more white pixels than others = local player
- Could also check for white pixels in a small ring just outside the teal border
- Threshold: even a few white pixels is signal, since other blobs should have ~zero

### Reliability Assessment: **HIGH** during movement, **NONE** when stationary
- Nearly perfect when the player is moving (which is most of the game)
- Needs fallback for stationary periods (viewport proximity or movement correlation)
- The line appears on every right-click, giving frequent re-confirmation opportunities

### Implementation Complexity: **VERY LOW**
- ~20-30 lines added to existing blob analysis
- No external dependencies
- No template images needed

---

## Approach 1: Camera Viewport Rectangle Detection (RECOMMENDED - Secondary)

### Concept
League renders a **white/light semi-transparent rectangle outline** on the minimap showing the camera's current field of view. Since most players either use locked camera or frequently re-center with spacebar, the **center of this rectangle strongly correlates with the local player's position**.

### How It Works
1. After creating the color mask for teal/red pixels, also detect **white/bright low-saturation pixels** in the minimap region
2. Find the rectangular outline formed by these pixels (connected component or Hough-like line detection)
3. Compute the rectangle's center point
4. Among all detected teal blobs, the one **closest to the viewport center** is most likely the local player

### Strengths
- Always present on the minimap (cannot be toggled off)
- Only visible on the LOCAL player's client (not spectator)
- Requires no template images or champion-specific data
- Works immediately on first frame (no warmup period needed)
- Implementation uses the same color filtering pipeline we already have

### Weaknesses
- Unlocked camera players may have the viewport far from their champion
- In practice, even unlocked-camera players frequently re-center (spacebar)
- The rectangle outline may partially overlap champion icons
- Need to distinguish from other white elements (pings, ward indicators)

### Detection Strategy
- White pixels: `r > 200 && g > 200 && b > 200` (high brightness, low saturation)
- The viewport rectangle is larger than champion icons (~40-80px wide on minimap)
- Look for a rectangular outline with consistent width/height
- Alternative: skip full rectangle detection, just find the centroid of all white pixels as an approximation of viewport center

### Reliability Assessment: **HIGH** as a spatial prior
- Correct within ~50 game units for locked-camera players
- Correct within ~200 game units for most unlocked-camera players (frequent re-centering)
- Combined with other approaches, provides strong initial identification

### Implementation Complexity: **LOW**
- ~30-40 lines added to existing color classification
- No external dependencies

---

## Approach 2: Movement Correlation (RECOMMENDED - Secondary/Confirmation)

### Concept
Track all teal blob positions across consecutive frames. The blob whose **movement pattern most closely matches the camera viewport's movement** is the local player, since the camera follows (or frequently re-centers on) the player.

### How It Works
1. Each frame, record viewport center position and all teal blob positions
2. Compute frame-to-frame deltas: `delta_cam = (cam[t] - cam[t-1])` and `delta_blob[i] = (blob_i[t] - blob_i[t-1])`
3. Over a sliding window (10-20 frames = 1.25-2.5 seconds), compute Pearson correlation between camera deltas and each blob's deltas
4. The blob with the highest correlation is the local player
5. Once identified with high confidence, switch to position-continuity tracking (current LOCKED behavior)

### Strengths
- Does not require any image recognition at all (purely positional)
- Very robust: no dependence on icon appearance, fog, pings, or visual artifacts
- Self-correcting: even if initial identification is wrong, correlation converges within seconds
- Works with any champion, any skin, any game state

### Weaknesses
- Requires 1-3 seconds of movement data before initial identification
- Standing still (in base, dead) provides no movement signal
- In teamfights, multiple allies may move in similar directions
- Requires viewport detection to work (depends on Approach 1)

### Algorithm Detail
```
For each frame t:
  cam_dx[t] = viewport_center_x[t] - viewport_center_x[t-1]
  cam_dy[t] = viewport_center_y[t] - viewport_center_y[t-1]

  For each teal blob i:
    blob_dx[i][t] = blob_center_x[i][t] - nearest_blob_center_x[i][t-1]
    blob_dy[i][t] = similar

  correlation[i] = pearson(cam_dx, blob_dx[i]) + pearson(cam_dy, blob_dy[i])

  best_blob = argmax(correlation)
```

### Reliability Assessment: **HIGH** once movement data is available
- Nearly perfect for players who move frequently
- Degraded when stationary (combine with viewport proximity as fallback)

### Implementation Complexity: **LOW**
- ~40-50 lines of correlation math
- Sliding window buffer for position history
- No external dependencies

---

## Approach 3: Color Histogram Matching (Supplementary Signal)

### Concept
Compare the color distribution inside each detected blob (masking out the teal border ring) against the known champion's icon from Riot Data Dragon.

### How It Works
1. At session start, fetch the local champion's icon from Data Dragon: `https://ddragon.leagueoflegends.com/cdn/{version}/img/champion/{ChampionName}.png` (120x120)
2. Downscale to match minimap icon size (~24px), crop to inner circle (exclude border ring area)
3. Build a color histogram (e.g., 4 bins per channel = 64 total bins)
4. For each detected teal blob, extract pixels inside the bounding box, mask out the outer ring, build histogram
5. Compare histograms using chi-squared distance or histogram intersection
6. The blob with the lowest distance to the template histogram is the best match

### Strengths
- Champion portraits have distinctive color palettes (Brand = orange, Jinx = blue/pink, etc.)
- Only need to distinguish among 4-5 allies, not all 172 champions
- Color histograms are rotation/position invariant
- Can reuse existing `champion-fingerprints.json` data (already generated for all 173 champions with 2112 skin variants)

### Weaknesses
- Very few pixels available (~150-300 pixels in inner circle at 24px diameter)
- Fog of war darkens icons significantly (need brightness normalization)
- Some champion pairs have similar color palettes
- Minimap terrain bleeds into icon edges
- The border ring consumes a large fraction of the icon area

### Existing Infrastructure
- `src/data/champion-fingerprints.json` (5.7MB) already contains pre-computed 4-bin histograms for all champions and skins
- `src/core/template-match.ts` has NCC implementation (could be adapted for histogram comparison)

### Reliability Assessment: **MEDIUM** as standalone, **USEFUL** as tiebreaker
- Can distinguish champions with very different color palettes (e.g., Brand vs Lux)
- Struggles with similar-colored champions (e.g., two purple-themed champions)
- Best used as a scoring component alongside movement/viewport approaches

### Implementation Complexity: **LOW-MEDIUM**
- Need to fetch and process one Data Dragon icon
- Histogram extraction from detected blobs: ~40-50 lines
- Chi-squared comparison: ~10 lines
- Or reuse existing champion-fingerprints.json data

---

## Approach 4: Template Matching (NCC/SSIM)

### Concept
Pre-store the local champion's icon, downscale to minimap size, and compare pixel-by-pixel against each detected blob's interior using Normalized Cross-Correlation (NCC) or Structural Similarity Index (SSIM).

### How It Works
1. Fetch champion icon from Data Dragon (120x120), downscale to ~20px inner circle
2. For each teal blob, extract the inner region (mask out border ring)
3. Compute NCC or SSIM between template and blob interior
4. Highest score = best match

### Prior Experience in This Project
- `src/core/template-match.ts` implements NCC with mask support (113 lines, currently unused)
- Previous attempts with template matching were described as "snapped quickly but wasn't accurate"
- Multiple external projects (LeagueMinimapDetectionOpenCV, Minimap_Detector) report poor reliability with template matching alone

### Why It Struggled Before
- Full minimap scanning (searching everywhere) produced many false positives
- Now we have **constrained search**: only check inside already-detected blob bounding boxes
- This dramatically reduces false positives and computation

### Strengths
- Infrastructure already exists (`template-match.ts`)
- Constrained to blob interiors = much fewer false positives than before
- NCC is robust to global brightness changes
- SSIM libraries exist for JS (ssim.js)

### Weaknesses
- At 14-16px inner circle, very few pixels for meaningful correlation
- Skin variants change appearance significantly
- Fog of war, pings, and effects distort the icon
- The minimap renders icons differently from the Data Dragon square (circular crop, different lighting)

### Reliability Assessment: **LOW-MEDIUM** standalone, **USEFUL** as confirmation
- Much better than before since search is constrained to blob interiors
- Still unreliable as sole identification method at this scale
- Works best as a one-time confirmation of identification made by other methods

### Implementation Complexity: **MEDIUM**
- Template-match.ts exists but needs integration
- Need to handle circular masking, scale matching, skin variants
- Fetching Data Dragon icon adds network dependency at session start

---

## Approach 5: Perceptual Hashing

### Concept
Compute perceptual hashes (pHash, dHash, aHash) of both the template icon and each blob's interior, compare by Hamming distance.

### Assessment
- **aHash (Average Hash):** Too coarse at this scale. High false positive rate.
- **dHash (Difference Hash):** Captures gradient direction, somewhat resistant to fog darkening. Best of the three.
- **pHash (DCT-based):** Input is smaller than the hash's own working resolution (32x32), so it would be upscaling noise.

### Reliability Assessment: **LOW**
- Icons are too small (14-16px inner content) for perceptual hashes to distinguish similar champions
- At 8x8 working resolution, most "face-like" champion portraits produce similar hashes
- Not recommended as a primary or secondary approach

### Implementation Complexity: **LOW** (but not worth it)

---

## Approach 6: GEP/API Position Data

### Assessment: **NOT AVAILABLE**

Exhaustive research confirms:
- Overwolf GEP does NOT provide player map coordinates
- Riot Live Client Data API does NOT include x/y position
- The `position` field = lane role (TOP/MID/etc.), not coordinates
- SkinSpotlights Live Events API was removed in Patch 14.1
- This is intentional by Riot for competitive integrity
- CV on the minimap is the only ToS-compliant method

---

## Recommended Strategy: Layered Identification

### Phase 1: Immediate (Frame 0-1) — Viewport Proximity + Movement Path
1. Detect white pixels on the minimap (viewport rectangle + movement path line)
2. For initial frame, pick the teal blob closest to the viewport center (white pixel centroid)
3. Simultaneously, check each teal blob for adjacent white pixels from the movement path line
4. If a blob has movement path white pixels → immediate high-confidence identification
5. If no movement path detected → use viewport proximity as initial guess

**Expected accuracy:** ~90% with viewport proximity, ~99% when movement path is visible

### Phase 2: Confirmation (Frames 1-20, ~2.5 seconds) — Movement Correlation
1. Track all teal blob positions + viewport center across frames
2. Compute movement correlation between viewport deltas and each blob's deltas
3. Continue checking for movement path line signals on every frame
4. If correlation + path line both confirm the same blob → maximum confidence
5. If they disagree → trust the movement path line (it's unambiguous)

**Expected accuracy:** ~99%+ after 2-3 seconds

### Phase 3: Validation (One-time, optional) — Color Histogram Check
1. After identification stabilizes, extract the identified blob's color histogram
2. Compare against the local champion's expected histogram (from Data Dragon or champion-fingerprints.json)
3. Provides a sanity check but should not override movement path or correlation

### Fallback: Loss of Lock
- If tracked blob disappears for >2 seconds (death, fog of war), revert to Phase 1
- On respawn, restart from Phase 1 (viewport will be centered on fountain)
- Death/respawn events from GEP trigger explicit state reset

### State Machine Update
```
SCANNING:
  1. Classify white pixels (viewport + movement path)
  2. Check teal blobs for movement path adjacency → if found, immediate LOCKED
  3. Otherwise, pick nearest teal blob to viewport center
  4. Start correlation tracking
  → LOCKED when movement path detected OR correlation confidence > threshold

LOCKED:
  - Follow nearest teal blob to last position (existing behavior)
  - Periodically re-validate via movement path detection
  - If lost for >2s → SCANNING

DEAD:
  - Freeze position (existing behavior)
  - On respawn → SCANNING
```

---

## Implementation Priority

| Priority | Approach | Value | Effort | Notes |
|----------|----------|-------|--------|-------|
| **P0** | Movement path line detection | Very High | Very Low | Unambiguous local player signal, ~20 lines |
| **P0** | Viewport proximity (white pixel centroid) | High | Low | Fallback when player is stationary |
| **P1** | Movement correlation | High | Low | Sliding window + Pearson correlation, confirms P0 |
| **P2** | Color histogram validation | Medium | Low-Med | Optional sanity check |
| **P3** | Template matching (NCC) | Low-Med | Medium | Already have code, integrate if needed |
| **Skip** | Perceptual hashing | Low | Low | Not worth it at this icon size |

---

## Open Questions for Implementation

1. **Viewport rectangle detection method:** Full rectangle detection vs. simple white-pixel centroid? The centroid approach is simpler but may be skewed by other white elements (pings, ward indicators). Rectangle detection is more robust but more complex.

2. **Correlation window size:** Shorter window (10 frames = 1.25s) gives faster identification but noisier. Longer window (20 frames = 2.5s) is more reliable but slower to converge. Could use adaptive: start with viewport proximity, switch to correlation once enough data accumulates.

3. **Handling stationary players:** When standing still (base, waiting for objective), both viewport and movement correlation degrade. Color histogram becomes more important in these cases. Could also use "last known good identification" with timeout.

4. **Skin variants:** If using color histogram, the champion's skin affects their icon colors. Data Dragon provides default skin only. `champion-fingerprints.json` covers all skins. Could use the broadest histogram (union of all skin histograms) for matching.

5. **Minimap icon rendering differences:** Data Dragon icons are square with consistent lighting. Minimap icons are circular crops with game-specific rendering (darker, potentially fog-affected). May need to capture and store the "live" icon as a template after initial identification (existing design doc mentions this).

---

## References

- [Riot Data Dragon CDN](https://ddragon.leagueoflegends.com) — Champion icon images
- [LeagueMinimapDetectionOpenCV](https://github.com/Maknee/LeagueMinimapDetectionOpenCV) — Template matching approach (reported unreliable)
- [nlml - Getting Champion Coordinates from the LoL Minimap](https://nlml.github.io/neural-networks/getting-champion-coordinates-from-the-lol-minimap/) — Deep learning approach
- [PandaScore - Champion Coordinates via Deep Learning](https://www.pandascore.co/blog/league-of-legends-getting-champion-coordinates-from-the-minimap-using-deep-learning)
- [lol-viewport-finder](https://github.com/rufusl/lol-viewport-finder) — Camera viewport detection
- [Overwolf GEP LoL Documentation](https://dev.overwolf.com/ow-native/live-game-data-gep/supported-games/league-of-legends/)
- [Riot Live Client Data API](https://developer.riotgames.com/docs/lol#game-client-api)
- Existing project code: `src/core/template-match.ts`, `src/data/champion-fingerprints.json`
