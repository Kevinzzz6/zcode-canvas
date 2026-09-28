// Contour terrain kernel from dsh-theme-endfield (https://github.com/ymh0000123/dsh-theme-endfield),
// client.js at c3e5017dc90426cb5dbc7537cfb11c8846aabdf4, cut out verbatim by function name the same
// way its scripts/build-contour-worker.js does. Only used by scripts/build-endfield.mjs.
//
// MIT License — Copyright (c) 2026 ymh0000123
//
// Evaluated with node:vm; the host supplies contourSeed, contourLineCv and contourStroke, and reads
// contourPaths / contourGeom back.
const CONTOUR_STEP = 6, CONTOUR_LEVELS = 20, CONTOUR_SPAN = 1.45
const CONTOUR_MIN_LEN = 40, CONTOUR_MIN_RING_BOX = 21
const CONTOUR_KEEP_LEN = CONTOUR_MIN_LEN * 1.35, CONTOUR_KEEP_RING = CONTOUR_MIN_RING_BOX * 1.5
const CONTOUR_MIN_CROSSINGS = 3
let contourField = null, contourGeom = null, contourPaths = []
const contourRng = (seed) => {
      let a = seed >>> 0
      return () => {
        a = (a + 0x6D2B79F5) >>> 0
        let t = Math.imul(a ^ (a >>> 15), 1 | a)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
      }
    }
const contourBuild = (w, h) => {
      /* ACCEPT-OR-REROLL. A random layout is not automatically a GOOD layout, and
         this is the concrete lesson from making the seed per-load: the old fixed
         seed had silently guaranteed a well-spread field, and once real randomness
         arrived, some layouts left regions with no contour lines at all. Measured on
         the 8x5 coverage grid ("near-empty" = under 0.6% ink):
             independent uniform placement   5 failures in 12 seeds (up to 3 cells)
             stratified placement alone      6 failures in 24 seeds (down to 0.00%)
         Stratification fixes clumping but cannot fix the real mechanism: lines
         appear only where the field CROSSES one of the 21 fixed levels, so a region
         that is locally flat between two levels is blank no matter how the bumps
         sit. Forcing a gradient steep enough to guarantee a crossing per cell would
         take ~9.5 parallel lines across the width, which reads as stripes, not
         terrain -- so distorting the field is the wrong lever.
         Instead the candidate layout is CHECKED against the same invariant the test
         asserts, and rejected if it fails. Each attempt is cheap (one field
         evaluation on a coarse grid, no extraction, no drawing) and bounded, so the
         worst case is a handful of evaluations at mount/resize time only.

         The two halves are BOTH load-bearing, which was verified rather than
         assumed -- with the validator in place but placement reverted to uniform,
         4 of 8 loads exhausted the 12-attempt cap and shipped a fallback layout
         (one run in four still rendered a blank cell). Stratification is what makes
         an acceptable layout the common case: mean 2.5 candidates, max 6, never at
         the cap. Validation is what makes it a guarantee. */
      const attempts = 32
      let best = null
      for (let attempt = 0; attempt < attempts; attempt++) {
        const cand = contourBuildCandidate(w, h, attempt)
        const score = contourCoverageScore(cand, w, h)
        if (best === null || score.worst > best.score.worst) best = { cand, score }
        // Comfortably above the 0.6%-ink failure line, in field terms: every cell
        // must contain a spread of values wider than one level gap, so at least one
        // level is guaranteed to cross it.
        if (score.ok) break
      }
      contourField = best.cand.field
      contourGeom = { w, h, cols: best.cand.cols, rows: best.cand.rows, step: CONTOUR_STEP }
    }
const contourBuildCandidate = (w, h, salt) => {
      const step = CONTOUR_STEP
      const cols = Math.ceil(w / step) + 1
      const rows = Math.ceil(h / step) + 1
      const K = 22                       // bump count: tuned to the reference's island density
      const rnd = contourRng((contourSeed + salt * 0x9E3779B1) >>> 0)
      const m = Math.min(w, h)
      const bx = new Float32Array(K), by = new Float32Array(K)
      const ba = new Float32Array(K), bs = new Float32Array(K)
      const dx = new Float32Array(K), dy = new Float32Array(K)
      /* STRATIFIED placement, not independent uniform draws.

         Uniform sampling clumps: measured over 12 random seeds it left up to 3
         near-empty cells. Jittered grid instead -- the viewport is cut into a
         near-square lattice of at least K cells and each bump is placed at a random
         point inside its own cell. That keeps placement random while making a large
         empty patch geometrically impossible. Cells are ordered by a Fisher-Yates
         shuffle so the bump INDEX carries no positional bias: index drives
         amplitude, radius and drift below, and walking cells in raster order would
         correlate "left side of the screen" with "first sizes drawn".
         The lattice spans the same -0.1..1.1 over-scan as before, so islands are
         still cut by the viewport edges rather than all sitting fully inside. */
      const gx = Math.max(1, Math.round(Math.sqrt(K * (w / Math.max(1, h)))))
      const gy = Math.max(1, Math.ceil(K / gx))
      const cells = []
      for (let j = 0; j < gy; j++) for (let i = 0; i < gx; i++) cells.push(i + j * gx)
      for (let i = cells.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1))
        const t = cells[i]; cells[i] = cells[j]; cells[j] = t
      }
      const spanX = 1.2 * w, spanY = 1.2 * h
      for (let k = 0; k < K; k++) {
        const cell = cells[k % cells.length]
        const ci = cell % gx
        const cj = Math.floor(cell / gx)
        // Random point inside this cell, in the over-scanned -0.1..1.1 space.
        bx[k] = -0.1 * w + ((ci + rnd()) / gx) * spanX
        by[k] = -0.1 * h + ((cj + rnd()) / gy) * spanY
        // Mixed sign gives peaks AND basins; equal signs would read as one blob.
        ba[k] = (rnd() < 0.5 ? -1 : 1) * (0.6 + rnd() * 0.9)
        bs[k] = (0.05 + rnd() * 0.09) * m
        dx[k] = rnd() * 2 - 1
        dy[k] = rnd() * 2 - 1
      }
      /* Base undulation: three long, low-amplitude sine ridges spanning the whole
         viewport. Reason this exists, from reviewing the first render: a sum of
         gaussians decays to EXACTLY zero between islands, so the field there is
         perfectly flat, no level ever crosses it, and the result had large blank
         patches that exposed the construction. Real terrain has no such voids. The
         ridges are far too gentle to create islands of their own — they just tilt
         the whole sheet enough that contour lines keep running through the gaps,
         which is what turns isolated bullseyes into one continuous landscape. */
      const W2 = new Float32Array(9)
      for (let i = 0; i < 3; i++) {
        W2[i * 3] = (0.35 + rnd() * 0.5) * (Math.PI * 2) / Math.max(1, w)  // x freq
        W2[i * 3 + 1] = (0.35 + rnd() * 0.5) * (Math.PI * 2) / Math.max(1, h) // y freq
        W2[i * 3 + 2] = rnd() * Math.PI * 2                                 // phase
      }
      const hCount = (cols - 1) * rows
      const eCount = hCount + cols * (rows - 1)
      const field = {
        cols, rows, step, K, bx, by, ba, bs, dx, dy, hCount, W2,
        F: new Float32Array(cols * rows),
        previous: new Float32Array(cols * rows),
        hasPrevious: false,
        smooth: new Float32Array(cols * rows),
        // Exact row-block bounds include both rows and the shared right vertex.
        // They reject empty regions without changing retained cells or path order.
        blockCols: Math.ceil((cols - 1) / 16),
        blockMin: new Float32Array(Math.ceil((cols - 1) / 16) * (rows - 1)),
        blockMax: new Float32Array(Math.ceil((cols - 1) / 16) * (rows - 1)),
        boundsReady: false,
        ex: new Float32Array(eCount),
        ey: new Float32Array(eCount),
        es: new Int32Array(eCount).fill(-1),
        n1: new Int32Array(eCount).fill(-1),
        n2: new Int32Array(eCount).fill(-1),
        seen: new Int32Array(eCount).fill(-1),
        touched: new Int32Array(eCount),
        seq: 0,
      }
      return { field, cols, rows }
    }
const contourCoverageScore = (cand, w, h) => {
      const f = cand.field
      // Evaluate at phase 0: the accepted layout must be sound as first painted.
      const prev = contourField
      contourField = f
      contourEvaluate(0)
      contourField = prev
      const { cols, rows, F } = f
      const GX = 8, GY = 5
      const span = CONTOUR_SPAN
      const levelStep = (span * 2) / CONTOUR_LEVELS
      let worst = Infinity
      let ok = true
      for (let gy = 0; gy < GY; gy++) {
        for (let gx = 0; gx < GX; gx++) {
          const i0 = Math.floor(gx * (cols - 1) / GX), i1 = Math.ceil((gx + 1) * (cols - 1) / GX)
          const j0 = Math.floor(gy * (rows - 1) / GY), j1 = Math.ceil((gy + 1) * (rows - 1) / GY)
          let mn = Infinity, mx = -Infinity
          for (let j = j0; j <= j1 && j < rows; j++) {
            const row = j * cols
            for (let i = i0; i <= i1 && i < cols; i++) {
              const v = F[row + i]
              if (v < mn) mn = v
              if (v > mx) mx = v
            }
          }
          // Clamp to the drawn level range: values beyond +/-SPAN produce no lines.
          const lo = Math.max(mn, -span), hi = Math.min(mx, span)
          // How many level boundaries fall inside this cell's clamped range.
          const crossings = hi <= lo ? 0
            : Math.floor(hi / levelStep) - Math.ceil(lo / levelStep) + 1
          if (crossings < worst) worst = crossings
          if (crossings < CONTOUR_MIN_CROSSINGS) ok = false
        }
      }
      return { ok, worst }
    }
const contourEvaluate = (phase) => {
      const f = contourField
      if (f !== null) f.boundsReady = false
      if (f === null) return
      const { cols, rows, step, K, bx, by, ba, bs, dx, dy, F, W2 } = f
      /* Seed the sheet with the base undulation instead of zero, so the gaps
         between islands still have a gradient for the levels to cross. Separable
         evaluation: sin(a+b) is expanded so the y term is computed once per row
         rather than once per cell, which keeps this pass cheap. */
      const BASE = 0.62
      for (let i = 0; i < 3; i++) {
        const fx = W2[i * 3], fy = W2[i * 3 + 1], ph = W2[i * 3 + 2] + phase * 0.11
        const amp = BASE / 3
        for (let j = 0; j < rows; j++) {
          const yb = fy * (j * step) + ph
          const sy = Math.sin(yb), cy2 = Math.cos(yb)
          const row = j * cols
          for (let c2 = 0; c2 < cols; c2++) {
            const xb = fx * (c2 * step)
            // sin(xb + yb) without a per-cell sin() of the sum
            const v = Math.sin(xb) * cy2 + Math.cos(xb) * sy
            if (i === 0) F[row + c2] = amp * v
            else F[row + c2] += amp * v
          }
        }
      }
      for (let k = 0; k < K; k++) {
        const s = bs[k]
        const amp = s * 0.55
        const cx = bx[k] + Math.sin(phase * dx[k] + k * 1.7) * amp
        const cy = by[k] + Math.cos(phase * dy[k] + k * 2.3) * amp
        const a = ba[k]
        const inv = 1 / (2 * s * s)
        const rad = 2.6 * s
        let i0 = Math.floor((cx - rad) / step)
        let i1 = Math.ceil((cx + rad) / step)
        let j0 = Math.floor((cy - rad) / step)
        let j1 = Math.ceil((cy + rad) / step)
        if (i0 < 0) i0 = 0
        if (j0 < 0) j0 = 0
        if (i1 > cols - 1) i1 = cols - 1
        if (j1 > rows - 1) j1 = rows - 1
        for (let j = j0; j <= j1; j++) {
          const ddy = j * step - cy
          const dy2 = ddy * ddy
          const row = j * cols
          for (let i = i0; i <= i1; i++) {
            const ddx = i * step - cx
            const q = (ddx * ddx + dy2) * inv
            if (q < 6.76) {
              let weight = Math.exp(-q)
              if (q > 4.8) {
                const t = (q - 4.8) / (6.76 - 4.8)
                const fade = 1 - t * t * (3 - 2 * t)
                weight *= fade
              }
              F[row + i] += a * weight
            }
          }
        }
      }
      const smooth = f.smooth
      for (let pass = 0; pass < 5; pass++) {
        for (let j = 0; j < rows; j++) {
          const row = j * cols
          for (let i = 0; i < cols; i++) {
            const left = F[row + Math.max(0, i - 1)]
            const center = F[row + i]
            const right = F[row + Math.min(cols - 1, i + 1)]
            smooth[row + i] = (left + 2 * center + right) * 0.25
          }
        }
        for (let j = 0; j < rows; j++) {
          const row = j * cols
          const up = Math.max(0, j - 1) * cols
          const down = Math.min(rows - 1, j + 1) * cols
          for (let i = 0; i < cols; i++) {
            F[row + i] = (smooth[up + i] + 2 * smooth[row + i] + smooth[down + i]) * 0.25
          }
        }
      }
      /* Track the field continuously between animation samples. Marching squares
         can change an entire path at once when a saddle crosses a level; blending
         the sampled field keeps that topology change from appearing as a twitch. */
      if (f.hasPrevious && f.previous !== undefined) {
        for (let i = 0; i < F.length; i++) {
          f.previous[i] = f.previous[i] * 0.65 + F[i] * 0.35
          F[i] = f.previous[i]
        }
      } else if (f.previous !== undefined) {
        f.previous.set(F)
      }
      f.hasPrevious = true
    }
const contourExtractLevel = (L, out) => {
      const f = contourField
      const { cols, rows, step, F, ex, ey, es, n1, n2, seen, touched, hCount } = f
      const st = ++f.seq
      let tn = 0
      const pt = (id, i0, j0, i1, j1) => {
        if (es[id] === st) return id
        const a = F[j0 * cols + i0]
        const b = F[j1 * cols + i1]
        let t = (L - a) / (b - a)
        if (!(t >= 0)) t = 0
        else if (t > 1) t = 1
        ex[id] = (i0 + (i1 - i0) * t) * step
        ey[id] = (j0 + (j1 - j0) * t) * step
        es[id] = st
        n1[id] = -1
        n2[id] = -1
        touched[tn++] = id
        return id
      }
      const link = (a, b) => {
        if (n1[a] < 0) n1[a] = b
        else if (n2[a] < 0) n2[a] = b
        if (n1[b] < 0) n1[b] = a
        else if (n2[b] < 0) n2[b] = a
      }
      for (let j = 0; j < rows - 1; j++) {
        const row = j * cols
        for (let i = 0; i < cols - 1; i++) {
          if (f.boundsReady && i % 16 === 0) {
            const block = j * f.blockCols + Math.floor(i / 16)
            if (L <= f.blockMin[block] || L > f.blockMax[block]) {
              i = Math.min(i + 16, cols - 1) - 1
              continue
            }
          }
          const p0 = row + i
          const p1 = p0 + 1
          const p3 = p0 + cols
          const p2 = p3 + 1
          const v0 = F[p0], v1 = F[p1], v2 = F[p2], v3 = F[p3]
          let mn = v0, mx = v0
          if (v1 < mn) mn = v1; else if (v1 > mx) mx = v1
          if (v2 < mn) mn = v2; else if (v2 > mx) mx = v2
          if (v3 < mn) mn = v3; else if (v3 > mx) mx = v3
          // Whole cell on one side of the level: nothing crosses it.
          if (L <= mn || L > mx) continue
          const idx = (v0 > L ? 1 : 0) | (v1 > L ? 2 : 0) | (v2 > L ? 4 : 0) | (v3 > L ? 8 : 0)
          const T = () => pt(j * (cols - 1) + i, i, j, i + 1, j)
          const B = () => pt((j + 1) * (cols - 1) + i, i, j + 1, i + 1, j + 1)
          const Le = () => pt(hCount + j * cols + i, i, j, i, j + 1)
          const Ri = () => pt(hCount + j * cols + i + 1, i + 1, j, i + 1, j + 1)
          switch (idx) {
            case 1: case 14: link(T(), Le()); break
            case 2: case 13: link(T(), Ri()); break
            case 3: case 12: link(Le(), Ri()); break
            case 4: case 11: link(Ri(), B()); break
            case 6: case 9: link(T(), B()); break
            case 7: case 8: link(Le(), B()); break
            // Ambiguous saddles use the bilinear asymptotic decider. The sign of
            // a*c-b*d selects whether the diagonal high/low regions are connected;
            // using the cell average alone is wrong when opposite corners differ in
            // magnitude and produces the long V-shaped joins seen in the render.
            case 5: {
              const a = v0 - L, b = v1 - L, c = v2 - L, d = v3 - L
              const saddle = a * c - b * d
              if (saddle > 0) { link(T(), Ri()); link(Le(), B()) }
              else { link(T(), Le()); link(Ri(), B()) }
              break
            }
            case 10: {
              const a = v0 - L, b = v1 - L, c = v2 - L, d = v3 - L
              const saddle = a * c - b * d
              if (saddle < 0) { link(T(), Le()); link(Ri(), B()) }
              else { link(T(), Ri()); link(Le(), B()) }
              break
            }
          }
        }
      }
      const walk = (start) => {
        const path = []
        let cur = start
        let prev = -1
        for (;;) {
          path.push(ex[cur], ey[cur])
          seen[cur] = st
          const a = n1[cur]
          const b = n2[cur]
          let nx = -1
          if (a >= 0 && a !== prev && seen[a] !== st) nx = a
          else if (b >= 0 && b !== prev && seen[b] !== st) nx = b
          if (nx < 0) {
            // Closed loop: step back onto the first point so the ring has no gap.
            if ((a === start || b === start) && path.length > 4) path.push(ex[start], ey[start])
            break
          }
          prev = cur
          cur = nx
        }
        return path
      }
      /* Reject debris before it reaches the draw list. Judged on the path's
         ON-CANVAS geometry, so an off-grid sliver with no visible pixels is
         dropped even when its raw length looks respectable. See the note on
         CONTOUR_MIN_LEN / CONTOUR_MIN_RING_BOX for the measurements behind both
         thresholds. */
      const W = contourGeom !== null ? contourGeom.w : 0
      const H = contourGeom !== null ? contourGeom.h : 0
      const keep = (p) => {
        if (p.length < 8) return false
        // Visible length, plus the bounding box of the part actually on screen.
        let vis = 0
        let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity
        let seenIn = false
        for (let k = 0; k < p.length; k += 2) {
          const x = p[k], y = p[k + 1]
          const inside = x >= 0 && x <= W && y >= 0 && y <= H
          if (inside) {
            seenIn = true
            if (x < minx) minx = x
            if (x > maxx) maxx = x
            if (y < miny) miny = y
            if (y > maxy) maxy = y
          }
          if (k >= 2) {
            const px2 = p[k - 2], py2 = p[k - 1]
            const prevIn = px2 >= 0 && px2 <= W && py2 >= 0 && py2 <= H
            if (inside && prevIn) {
              const dx = x - px2, dy = y - py2
              vis += Math.sqrt(dx * dx + dy * dy)
            }
          }
        }
        if (!seenIn) return false            // entirely off-canvas: pure debris
        if (vis < CONTOUR_KEEP_LEN) return false
        /* A tiny CLOSED ring is an apex bullseye and reads as a dot. Open chains of
           the same extent are left alone: they are the visible corner of a stroke
           that continues off-canvas, and clipping one would punch a hole in a line
           the user can see running to the edge. */
        const gapx = p[0] - p[p.length - 2]
        const gapy = p[1] - p[p.length - 1]
        const closed = (gapx * gapx + gapy * gapy) < 4
        if (closed && (maxx - minx) < CONTOUR_KEEP_RING
          && (maxy - miny) < CONTOUR_KEEP_RING) return false
        return true
      }
      /* TANGENCY NEEDLES. Where a level runs nearly TANGENT to the field, the true
         isoline has a smooth, very high curvature tip. Marching squares interpolates
         linearly on a 10px grid, so it cannot represent that tip: it emits a hairpin
         that goes out and comes straight back, with a BASE (the gap between the
         apex's two neighbours) far narrower than the 1px stroke. Measured on the real
         output, worst case: apex 6.26px out from a base of 0.831px.

         At that width the outbound and return strokes paint the SAME pixels, so the
         pair does not read as a narrow valley — only the protruding whisker shows,
         which is precisely the "irregular sharp angle" in issue #3. Smoothing cannot
         help: the midpoint spline faithfully reproduces a feature that is genuinely
         in the geometry, so it has to be removed here, at the source.

         The whole hairpin is collapsed (see the note on the merge below). Both tests
         are required and were measured over 24 frames (152.6k vertices, 1.18Mpx of
         ink):
           base < 2px   the stroke cannot resolve it (a 1px line is ~1px wide)
           turn > 90    it doubles back rather than merely turning a corner
         That is 0.7 vertices per frame and 0.0037% of total ink -- artifact removal,
         not thinning. Real narrow features are untouched: turns over 90 degrees have
         a median base of 4.03px, well clear of the cutoff, and the whole 8-12px base
         band (29562 vertices) has a p99 turn of only 21.7 degrees. */
      const deneedle = (p) => {
        const n = p.length / 2
        if (n < 4) return p
        /* Scan first and return the ORIGINAL array when there is nothing to do, so
           the overwhelmingly common path allocates nothing at 24fps. */
        let found = false
        for (let k = 1; k < n - 1; k++) {
          const bx = p[(k + 1) * 2] - p[(k - 1) * 2]
          const by = p[(k + 1) * 2 + 1] - p[(k - 1) * 2 + 1]
          if (bx * bx + by * by >= 4) continue          // base >= 2px: keep
          const ax = p[k * 2] - p[(k - 1) * 2]
          const ay = p[k * 2 + 1] - p[(k - 1) * 2 + 1]
          const cx = p[(k + 1) * 2] - p[k * 2]
          const cy = p[(k + 1) * 2 + 1] - p[k * 2 + 1]
          // turn > 90 degrees <=> the two segment vectors point against each other.
          if (ax * cx + ay * cy < 0) { found = true; break }
        }
        if (!found) return p
        const gx = p[0] - p[(n - 1) * 2]
        const gy = p[1] - p[(n - 1) * 2 + 1]
        const closed = (gx * gx + gy * gy) < 4
        /* COLLAPSE THE WHOLE NEEDLE, not just its tip. Dropping the apex alone leaves
           the base itself as a real segment, and that was measured to be worse than
           the disease: a 0.831px stub inherits the reversal as TWO ~78-degree turns
           (10.20 -> 0.83 -> 10.25px). The apex AND its far neighbour are therefore
           both consumed, and the surviving previous vertex is pulled onto the base
           midpoint -- a sub-pixel move (half of at most 2px) that no 1px stroke can
           show, leaving one smooth vertex where the hairpin was.
           Each test uses the SURVIVING previous vertex, so a run of needles collapses
           progressively instead of each test being fooled by a neighbour that is
           itself about to be consumed. */
        const q = [p[0], p[1]]
        let k = 1
        while (k < n - 1) {
          const px = q[q.length - 2], py = q[q.length - 1]
          const bx = p[(k + 1) * 2] - px, by = p[(k + 1) * 2 + 1] - py
          if (bx * bx + by * by < 4) {
            const ax = p[k * 2] - px, ay = p[k * 2 + 1] - py
            const cx = p[(k + 1) * 2] - p[k * 2], cy = p[(k + 1) * 2 + 1] - p[k * 2 + 1]
            if (ax * cx + ay * cy < 0) {
              if (k + 1 < n - 1) {
                q[q.length - 2] = (px + p[(k + 1) * 2]) / 2
                q[q.length - 1] = (py + p[(k + 1) * 2 + 1]) / 2
                k += 2
                continue
              }
              // The far neighbour is the final vertex, which must survive to keep an
              // endpoint (or a ring's closure) intact: consume only the apex.
              k += 1
              continue
            }
          }
          q.push(p[k * 2], p[k * 2 + 1])
          k += 1
        }
        q.push(p[(n - 1) * 2], p[(n - 1) * 2 + 1])
        /* A ring is closed by REPEATING its start vertex, and the merge above may have
           nudged that start. Re-anchor the repeat so the ring stays exactly closed and
           both keep() and the cyclic draw path still classify it as one. */
        if (closed) {
          q[q.length - 2] = q[0]
          q[q.length - 1] = q[1]
        }
        return q
      }
      // Open chains first (they have a free end), then whatever remains is a loop.
      // Doing it in this order stops a ring being entered mid-way and split in two.
      for (let k = 0; k < tn; k++) {
        const id = touched[k]
        if (seen[id] !== st && n2[id] < 0) {
          const p = deneedle(walk(id))
          if (keep(p)) out.push(p)
        }
      }
      for (let k = 0; k < tn; k++) {
        const id = touched[k]
        if (seen[id] !== st) {
          const p = deneedle(walk(id))
          if (keep(p)) out.push(p)
        }
      }
    }
const contourExtract = (phase, trailPoints, trailNow) => {
      if (contourField === null) return
      contourEvaluate(phase)
      if (trailPoints && trailPoints.length) contourOverlayTrail(contourField, trailPoints, trailNow)
      const f = contourField
      // One O(cells) range pass is shared by all 21 extraction levels. Scratch
      // survives across frames; no resolution, smoothing or density is reduced.
      for (let j = 0; j < f.rows - 1; j++) {
        const row = j * f.cols
        for (let block = 0; block < f.blockCols; block++) {
          const begin = block * 16
          const end = Math.min(begin + 16, f.cols - 1)
          let min = Infinity, max = -Infinity
          for (let i = begin; i <= end; i++) {
            const a = f.F[row + i], b = f.F[row + f.cols + i]
            if (a < min) min = a
            if (a > max) max = a
            if (b < min) min = b
            if (b > max) max = b
          }
          const k = j * f.blockCols + block
          f.blockMin[k] = min
          f.blockMax[k] = max
        }
      }
      f.boundsReady = true
      contourPaths = []
      const span = CONTOUR_SPAN
      const stepL = (span * 2) / CONTOUR_LEVELS
      for (let n = 0; n <= CONTOUR_LEVELS; n++) {
        contourExtractLevel(-span + n * stepL, contourPaths)
      }
    }
const contourDrawLines = () => {
      if (contourLineCv === null || contourGeom === null) return
      const ctx = contourLineCv.getContext('2d')
      if (!ctx) return
      const { w, h } = contourGeom
      /* Geometry stays in CSS px; scale the context to the backing store that
         contourSizeTo sized at (capped) devicePixelRatio, so strokes rasterise
         at device resolution instead of being upsampled into blur on HiDPI
         screens. Derived from the canvas itself, and skipped entirely at a 1x
         store or when the context has no setTransform (the spliced-in test
         harnesses), so a 1x render is byte-identical to before. */
      const scale = (w > 0 && typeof contourLineCv.width === 'number' && contourLineCv.width > 0 && contourLineCv.width !== w)
        ? contourLineCv.width / w : 1
      if (scale !== 1 && typeof ctx.setTransform === 'function') ctx.setTransform(scale, 0, 0, scale, 0, 0)
      ctx.clearRect(0, 0, w, h)
      ctx.strokeStyle = contourStroke()
      ctx.lineWidth = 1
      ctx.lineJoin = 'round'
      /* Marching squares emits one vertex per grid-cell edge. Three Chaikin passes
         cut local corners before the clamped cubic B-spline rounds broad bends.
         This reduces angularity without changing the field or adding another
         extraction pass. Open endpoints remain fixed; closed rings wrap cyclically. */
      const smoothPath = (source) => {
        const count = source.length / 2
        if (count < 3) return source
        let points = []
        for (let k = 0; k < source.length; k += 2) points.push([source[k], source[k + 1]])
        const closed = (points[0][0] - points[points.length - 1][0]) ** 2
          + (points[0][1] - points[points.length - 1][1]) ** 2 < 4
        if (closed) points.pop()
        for (let pass = 0; pass < 3; pass++) {
          const next = []
          const limit = closed ? points.length : points.length - 1
          if (!closed) next.push(points[0])
          for (let k = 0; k < limit; k++) {
            const a = points[k]
            const b = points[(k + 1) % points.length]
            next.push([
              a[0] * 0.75 + b[0] * 0.25,
              a[1] * 0.75 + b[1] * 0.25,
            ], [
              a[0] * 0.25 + b[0] * 0.75,
              a[1] * 0.25 + b[1] * 0.75,
            ])
          }
          if (!closed) next.push(points[points.length - 1])
          points = next
        }
        const result = []
        for (const point of points) result.push(point[0], point[1])
        if (closed) result.push(result[0], result[1])
        return result
      }
      /* Chaikin removes local grid noise. A constrained Catmull-Rom cubic then
         gives each join one shared tangent. The handle cap prevents overshoot at
         narrow saddles while the larger tangent factor removes long rounded-polygon
         bends that remain visible with midpoint quadratics. */
      const drawSmoothPath = (source) => {
        const count = source.length / 2
        if (count < 3) {
          ctx.moveTo(source[0], source[1])
          for (let k = 2; k < source.length; k += 2) ctx.lineTo(source[k], source[k + 1])
          return
        }
        const closed = (source[0] - source[source.length - 2]) ** 2
          + (source[1] - source[source.length - 1]) ** 2 < 4
        const limit = closed ? count - 1 : count
        const point = (index) => {
          const k = closed
            ? (index + limit) % limit
            : Math.max(0, Math.min(limit - 1, index))
          return [source[k * 2], source[k * 2 + 1]]
        }
        const tangent = (index) => {
          const current = point(index)
          const previous = point(index - 1)
          const next = point(index + 1)
          let tx, ty, cap
          const incomingX = current[0] - previous[0]
          const incomingY = current[1] - previous[1]
          const outgoingX = next[0] - current[0]
          const outgoingY = next[1] - current[1]
          if (!closed && index === 0) {
            tx = outgoingX * 0.4
            ty = outgoingY * 0.4
            cap = Math.hypot(outgoingX, outgoingY) * 0.55
          } else if (!closed && index === limit - 1) {
            tx = incomingX * 0.4
            ty = incomingY * 0.4
            cap = Math.hypot(incomingX, incomingY) * 0.55
          } else {
            tx = (next[0] - previous[0]) * 0.32
            ty = (next[1] - previous[1]) * 0.32
            cap = Math.min(
              Math.hypot(incomingX, incomingY),
              Math.hypot(outgoingX, outgoingY),
            ) * 0.62
          }
          const length = Math.hypot(tx, ty)
          if (length > cap && length > 0) {
            tx *= cap / length
            ty *= cap / length
          }
          return [tx, ty]
        }
        ctx.moveTo(source[0], source[1])
        const segments = closed ? limit : limit - 1
        for (let k = 0; k < segments; k++) {
          const start = point(k)
          const end = point(k + 1)
          const startTangent = tangent(k)
          const endTangent = tangent(k + 1)
          ctx.bezierCurveTo(
            start[0] + startTangent[0], start[1] + startTangent[1],
            end[0] - endTangent[0], end[1] - endTangent[1],
            end[0], end[1],
          )
        }
        /* Mark a ring as a RING. The cyclic tangents above already make the seam C1
           and the final span already lands exactly on the start point, so this adds
           no geometry — but without it the canvas treats the path as open and butts
           two caps together at the seam instead of joining them, which is defect (2)
           of issue #3. contour-cusps.test.js guards this. */
        if (closed) ctx.closePath()
      }
      ctx.beginPath()
      for (let i = 0; i < contourPaths.length; i++) drawSmoothPath(smoothPath(contourPaths[i]))
      ctx.stroke()
    }
