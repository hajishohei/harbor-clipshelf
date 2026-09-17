'use strict';
// Paste-style sound feedback ("効果音"). Played through the HUD window.
function createSounds({ hud, getSettings }) {
  let last = 0;
  return {
    play(name) {
      if (!getSettings().soundEffects) return;
      const now = Date.now();
      if (now - last < 80) return;
      last = now;
      hud.sound(name);
    }
  };
}
module.exports = { createSounds };
