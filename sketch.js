// Sand dune — height-aware settling + weak x-snap
// - Active-active repulsion removed
// - If a column is relatively high, particles are encouraged to settle in neighbor columns
// - settleGrain internals unchanged (stability/immobile logic preserved)
// - SPACE: random base color; generated particles use base / +30 / -30 RGB variants

let particles = [];
let settledGrid = [];
let settledHeights = [];
let cols;
let colWidth = 3;
let gravity;

// Tunables
let spawnRate = 4;
let maxParticles = 1600;

let minR = 0.5, maxR = 1.2;
let largeChance = 0.1;
let largeMaxR = 3.0;

let baseCollideStrength = 0.28;
let lateralBase = 0.55;
let damping = 0.95;

// timings
let freezeAfterMs = 9000;
let movingGrainFreezeMs = 8000;
let grainLockMs = 600;
let grainStabilityIncrement = 0.045;
let grainStabilityThreshold = 0.72;

let settledLayer;
let uiColor = { r: 230, g: 190, b: 120 };
let uiBoxSize = 48, uiPadding = 10;

// relax tuning
let relaxIntervalFrames = 1;
let relaxPasses = 3;
let relaxTimer = 0;

// Height-dependent settling params
let heightBiasThresholdPx = 6.0; // 픽셀 단위: centre가 neighbor보다 이만큼 높으면 거부 고려
let heightRejectMaxProb = 0.9;    // 최대 거부 확률

function setup() {
  createCanvas(windowWidth, windowHeight);
  pixelDensity(1);
  gravity = createVector(0, 0.34);

  cols = max(12, floor(width / colWidth));
  settledHeights = new Array(cols).fill(0);
  settledGrid = new Array(cols).fill(0).map(() => []);

  settledLayer = createGraphics(width, height);
  settledLayer.pixelDensity(1);
  settledLayer.clear();

  noStroke();
  textSize(12);
}

function draw() {
  background(18);

  settledLayer.loadPixels();

  if (mouseIsPressed) {
    for (let i = 0; i < spawnRate; i++) {
      if (particles.length < maxParticles) {
        // spawn distribution widened to avoid concentration
        let sx = constrain(mouseX + random(-50, 50), 0, width - 1);
        let sy = constrain(mouseY + random(-6, 6), 0, height - 1);
        particles.push(new Particle(createVector(sx, sy)));
      }
    }
  }

  for (let i = particles.length - 1; i >= 0; i--) {
    let p = particles[i];

    if (millis() - p.birthTime >= freezeAfterMs) {
      forceFreezeParticle(p);
      particles.splice(i, 1);
      continue;
    }

    // active-active repulsion removed

    p.applyForce(gravity);
    p.update();

    repulseFromImageIfNear(p);

    // weak collision with moving grains (data)
    handleCollisionWithGrains_weak(p);

    // ground contact
    let ci = constrain(floor(p.pos.x / colWidth), 0, cols - 1);
    let groundY = height - settledHeights[ci];
    if (p.pos.y + p.r >= groundY) {
      let lateral = computeLateralBias(ci, p);
      if (abs(p.vel.y) > 1.0) {
        p.vel.y *= -0.08; // very small bounce
        p.vel.x += lateral * lateralBase * (p.r / (maxR + 0.001));
      } else {
        // height-aware settle attempt
        let settled = trySettlePreferLower(p, ci, lateral);
        if (settled) particles.splice(i, 1);
        else {
          // rejection: nudge lateral and let particle continue
          p.vel.x += lateral * lateralBase * 0.9 + random(-0.06, 0.06);
          p.pos.y -= 0.4; // slight lift to avoid immediate re-contact
        }
      }
      continue;
    }

    if (p.pos.y > height + 400 || p.pos.x < -400 || p.pos.x > width + 400) {
      particles.splice(i, 1);
      continue;
    }

    p.show();
  }

  drawMovingGrains();
  image(settledLayer, 0, 0);

  // relax to spread dunes
  relaxTimer++;
  if (relaxTimer >= relaxIntervalFrames) {
    for (let r = 0; r < relaxPasses; r++) relaxColumns();
    relaxTimer = 0;
  }

  processGrainStability();

  drawColorBox();
  fill(240);
  text("particles: " + particles.length, 10, 10);
  text("moving grains: " + countMovingGrains(), 10, 26);
}

/* Particle */
class Particle {
  constructor(pos) {
    this.pos = pos.copy();
    this.vel = createVector(random(-0.6, 0.6), random(-1.6, -0.6));
    this.acc = createVector(0, 0);
    if (random() < largeChance) this.r = random(1.8, largeMaxR);
    else this.r = random(minR, maxR);
    this.colorBase = pickColorVariant(uiColor);
    this.birthTime = millis();
  }
  applyForce(f) { this.acc.add(f); }
  update() {
    this.vel.add(this.acc);
    this.pos.add(this.vel);
    this.acc.mult(0);
    this.vel.mult(0.997);
  }
  show() {
    noStroke();
    fill(this.colorBase);
    ellipse(this.pos.x, this.pos.y, this.r * 2, this.r * 2);
  }
}

/* color variants ±30 */
function pickColorVariant(base) {
  let v = floor(random(3));
  if (v === 0) return color(base.r, base.g, base.b);
  if (v === 1) return color(constrain(base.r + 30, 0, 255), constrain(base.g + 30, 0, 255), constrain(base.b + 30, 0, 255));
  return color(constrain(base.r - 30, 0, 255), constrain(base.g - 30, 0, 255), constrain(base.b - 30, 0, 255));
}

/* Height-aware settle decision (minimal changes to grain internals) */
function trySettlePreferLower(p, ci, lateralBias) {
  // neighbor heights
  let leftH = (ci > 0) ? settledHeights[ci - 1] : settledHeights[ci];
  let centerH = settledHeights[ci];
  let rightH = (ci < cols - 1) ? settledHeights[ci + 1] : settledHeights[ci];

  // compute relative excess in pixels
  let leftDiff = centerH - leftH;
  let rightDiff = centerH - rightH;

  // random jitter factor to avoid deterministic ties
  let jitter = random(0, 1);

  // compute rejection probability if center is noticeably higher than neighbors
  let rejectProb = 0;
  let maxDiff = max(leftDiff, rightDiff);
  if (maxDiff > heightBiasThresholdPx) {
    // scale the difference into [0..1] and map to [0..heightRejectMaxProb]
    let scaled = constrain((maxDiff - heightBiasThresholdPx) / (heightBiasThresholdPx * 4.0), 0, 1);
    rejectProb = scaled * heightRejectMaxProb;
  }

  // bias by absolute height: higher columns have slightly higher reject prob
  let absBias = constrain(centerH / (height * 0.85), 0, 1);
  rejectProb = constrain(rejectProb * (0.6 + 0.4 * absBias), 0, 0.98);

  // chance check
  if (random() < rejectProb) {
    // choose a lower neighbor if available (prefer direction by lateralBias or lower height)
    let target = ci;
    if (leftH < rightH) target = ci - 1;
    else if (rightH < leftH) target = ci + 1;
    if (lateralBias < -0.2 && ci > 0) target = ci - 1;
    if (lateralBias > 0.2 && ci < cols - 1) target = ci + 1;

    // if target valid and not overflowing, settle there
    if (target !== ci && settledHeights[target] + p.r * 2 < height) {
      settleGrainAtColumn_weakSnap(p, target);
      return true;
    } else {
      // cannot move - fallback settle here
      settleGrainAtColumn_weakSnap(p, ci);
      return true;
    }
  } else {
    // accept: settle at ci with weak x-snap
    settleGrainAtColumn_weakSnap(p, ci);
    return true;
  }
}

/* weakened snap setter: less center-snap, more spread within column */
function settleGrainAtColumn_weakSnap(p, ci) {
  let y = round(height - settledHeights[ci] - p.r);
  let maxOffset = colWidth * 0.8;
  let gx = constrain(p.pos.x + random(-maxOffset, maxOffset), ci * colWidth + 1, (ci + 1) * colWidth - 1);
  gx += random(-0.4, 0.4);
  let grain = {
    x: gx,
    y: y,
    r: p.r,
    col: p.colorBase,
    lockUntil: millis() + grainLockMs,
    stability: 0,
    immobile: false,
    settledAt: millis()
  };
  settledGrid[ci].push(grain);
  settledHeights[ci] += grain.r * 2;
}

/* draw moving grains */
function drawMovingGrains() {
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < settledGrid[i].length; j++) {
      let g = settledGrid[i][j];
      if (!g.immobile) {
        noStroke();
        fill(g.col);
        ellipse(g.x, g.y, g.r * 2, g.r * 2);
      }
    }
  }
}

/* weak collision with moving grains (mild bounce + lateral) */
function handleCollisionWithGrains_weak(p) {
  let ci = constrain(floor(p.pos.x / colWidth), 0, cols - 1);
  for (let di = -1; di <= 1; di++) {
    let ni = ci + di;
    if (ni < 0 || ni >= cols) continue;
    let col = settledGrid[ni];
    for (let k = col.length - 1; k >= max(0, col.length - 4); k--) {
      let g = col[k];
      if (g.immobile) continue;
      let d = dist(p.pos.x, p.pos.y, g.x, g.y);
      let minD = (p.r + g.r) * 1.6;
      if (d > 0 && d < minD) {
        let nx = (p.pos.x - g.x) / d;
        let ny = (p.pos.y - g.y) / d;
        let overlap = (minD - d);
        p.pos.x += nx * overlap * 0.5;
        p.pos.y += ny * overlap * 0.5;
        let bounce = baseCollideStrength * 0.6 * (p.r / (maxR + 0.001));
        p.vel.x += nx * bounce;
        p.vel.y += ny * bounce;
        let lateral = computeLateralFromGrain(ni, g);
        p.vel.x += lateral * lateralBase * 0.5;
        g.x -= nx * 0.03;
        g.y -= ny * 0.03;
        p.vel.mult(0.99);
        return true;
      }
    }
  }
  return false;
}

/* repulse from immobile painted pixels (light) */
function repulseFromImageIfNear(p) {
  let px = floor(constrain(p.pos.x, 0, settledLayer.width - 1));
  let py = floor(constrain(p.pos.y, 0, settledLayer.height - 1));
  for (let dy = 0; dy <= 2; dy++) {
    let y = py + dy;
    if (y >= settledLayer.height) break;
    let idx = (px + y * settledLayer.width) * 4;
    if (idx >= 0 && idx + 3 < settledLayer.pixels.length) {
      let a = settledLayer.pixels[idx + 3];
      if (a > 12) {
        p.vel.y -= 0.12;
        p.vel.x += random(-0.04, 0.04);
        break;
      }
    }
  }
}

/* relax & stability */
function relaxColumns() {
  let criticalSlope = 1.0;
  for (let i = 0; i < cols - 1; i++) {
    let hL = settledHeights[i], hR = settledHeights[i + 1];
    let diff = hL - hR;
    if (diff > criticalSlope) {
      if (settledGrid[i].length > 0) {
        let top = settledGrid[i][settledGrid[i].length - 1];
        if (!top.immobile && !(top.lockUntil && top.lockUntil > millis()) && top.stability < grainStabilityThreshold) {
          let g = settledGrid[i].pop();
          settledHeights[i] = max(0, settledHeights[i] - g.r * 2);
          g.x = constrain(g.x + colWidth, (i + 1) * colWidth + 1, (i + 2) * colWidth - 1);
          g.lockUntil = millis() + grainLockMs;
          g.stability = 0;
          g.y = round(height - settledHeights[i + 1] - g.r);
          settledGrid[i + 1].push(g);
          settledHeights[i + 1] += g.r * 2;
        }
      } else {
        let move = min(0.6, settledHeights[i]);
        settledHeights[i] -= move; settledHeights[i + 1] += move;
      }
    } else if (-diff > criticalSlope) {
      if (settledGrid[i + 1].length > 0) {
        let top = settledGrid[i + 1][settledGrid[i + 1].length - 1];
        if (!top.immobile && !(top.lockUntil && top.lockUntil > millis()) && top.stability < grainStabilityThreshold) {
          let g = settledGrid[i + 1].pop();
          settledHeights[i + 1] = max(0, settledHeights[i + 1] - g.r * 2);
          g.x = constrain(g.x - colWidth, i * colWidth + 1, (i + 1) * colWidth - 1);
          g.lockUntil = millis() + grainLockMs;
          g.stability = 0;
          g.y = round(height - settledHeights[i] - g.r);
          settledGrid[i].push(g);
          settledHeights[i] += g.r * 2;
        }
      } else {
        let move = min(0.6, settledHeights[i + 1]);
        settledHeights[i + 1] -= move; settledHeights[i] += move;
      }
    }
  }
}

function processGrainStability() {
  let now = millis();
  for (let i = 0; i < cols; i++) {
    let col = settledGrid[i];
    for (let j = 0; j < col.length; j++) {
      let g = col[j];
      if (!g.immobile) {
        g.stability = constrain((g.stability || 0) + grainStabilityIncrement, 0, 1);
        if (g.stability >= grainStabilityThreshold || (now - g.settledAt) >= movingGrainFreezeMs) {
          g.immobile = true;
          g.lockUntil = Infinity;
          g.stability = 1;
          drawGrainToBuffer_safe(g);
        }
      }
    }
  }
}

function drawGrainToBuffer_safe(g) {
  if (!settledLayer || typeof settledLayer.ellipse !== 'function') return;
  if (!g || typeof g.x !== 'number') return;
  let cr = uiColor.r, cg = uiColor.g, cb = uiColor.b;
  try {
    cr = red(g.col); cg = green(g.col); cb = blue(g.col);
  } catch (e) {}
  settledLayer.noStroke();
  settledLayer.fill(cr, cg, cb, 230);
  settledLayer.ellipse(g.x, g.y, g.r * 2, g.r * 2);
}

function countMovingGrains() {
  let c = 0;
  for (let i = 0; i < cols; i++) for (let g of settledGrid[i]) if (!g.immobile) c++;
  return c;
}

/* Helpers & UI */
function computeLateralBias(ci, p) {
  let left = (ci > 0) ? settledHeights[ci - 1] : Infinity;
  let right = (ci < cols - 1) ? settledHeights[ci + 1] : Infinity;
  let pref = 0;
  if (left + 0.5 < right) pref = -1;
  else if (right + 0.5 < left) pref = 1;
  if (p.vel.x < -0.25) pref = -1;
  if (p.vel.x > 0.25) pref = 1;
  return pref + random(-0.2, 0.2);
}

function computeLateralFromGrain(ci, g) {
  let left = (ci > 0) ? settledHeights[ci - 1] : Infinity;
  let right = (ci < cols - 1) ? settledHeights[ci + 1] : Infinity;
  if (left + 0.3 < right) return -0.6;
  if (right + 0.3 < left) return 0.6;
  return random(-0.04, 0.04);
}

/* UI */
function drawColorBox() {
  push();
  let bx = width - uiPadding - uiBoxSize;
  let by = uiPadding;
  stroke(180); fill(uiColor.r, uiColor.g, uiColor.b);
  rect(bx, by, uiBoxSize, uiBoxSize);
  noStroke(); fill(255); textSize(11);
  text("SPACE: random base color", bx - 180, by + uiBoxSize + 6);
  pop();
}

function keyPressed() {
  if (key === ' ') {
    uiColor = { r: random(120, 255), g: random(80, 230), b: random(60, 220) };
  }
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  cols = max(12, floor(width / colWidth));
  settledHeights = new Array(cols).fill(0);
  settledGrid = new Array(cols).fill(0).map(() => []);
  settledLayer = createGraphics(width, height);
  settledLayer.pixelDensity(1);
  settledLayer.clear();
}