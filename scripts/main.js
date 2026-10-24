/**
 * Ascandir - Music Switcher
 * Spielt je nach aktiver Szene und Kampfstatus automatisch passende Musik
 * und blendet beim Wechsel sauber aus und wieder ein.
 *
 * Ablauf:
 *  - Nur EIN Spielleiter-Client (der "aktive GM") steuert die Musik.
 *  - Ausblenden: Der GM markiert die laufenden Tracks mit einem Flag. Jeder
 *    Client (auch Spieler) sieht das Update und blendet lokal sanft auf 0 aus.
 *    Danach stoppt der GM die Tracks.
 *  - Einblenden: Foundrys eingebaute Fade-Dauer des Tracks wird kurz auf den
 *    eingestellten Wert gesetzt, der Track gestartet und die ursprüngliche
 *    Einstellung danach wiederhergestellt.
 */

const ID = "ascandir-music-switcher";
const FLAG = `flags.${ID}`;

/* -------------------------------------------- */
/*  Hilfsfunktionen                             */
/* -------------------------------------------- */

const log = (...args) => console.log(`${ID} |`, ...args);
const t = (key) => game.i18n.localize(`${ID}.${key}`);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function escapeHTML(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isResponsibleGM() {
  return game.user.isGM && (game.users.activeGM?.isSelf ?? true);
}

function setting(key) {
  return game.settings.get(ID, key);
}

/** Löst eine gespeicherte Referenz (UUID) in eine Playlist oder einen Track auf. */
function resolveTarget(ref) {
  if (!ref || ref === "none" || ref === "stop") return null;
  try {
    const doc = fromUuidSync(ref);
    if (doc && ["Playlist", "PlaylistSound"].includes(doc.documentName)) return doc;
  } catch (err) {
    /* ungültige Referenz */
  }
  return null;
}

function isPlaylistDoc(doc) {
  return doc?.documentName === "Playlist";
}

/* -------------------------------------------- */
/*  Auswahl-Optionen (Szene & Einstellungen)    */
/* -------------------------------------------- */

function buildOptions(current, { forScene = false } = {}) {
  const opts = [];
  const add = (value, label) => {
    const sel = value === (current ?? "") ? " selected" : "";
    opts.push(`<option value="${escapeHTML(value)}"${sel}>${escapeHTML(label)}</option>`);
  };

  if (forScene) {
    add("", t("options.useDefault"));
    add("none", t("options.keep"));
  } else {
    add("", t("options.keep"));
  }
  add("stop", t("options.stop"));

  const playlists = [...game.playlists].sort((a, b) => a.name.localeCompare(b.name));
  for (const pl of playlists) {
    opts.push(`<optgroup label="${escapeHTML(pl.name)}">`);
    add(pl.uuid, `♫ ${t("options.wholePlaylist")}: ${pl.name}`);
    const sounds = [...pl.sounds].sort((a, b) => (a.sort - b.sort) || a.name.localeCompare(b.name));
    for (const s of sounds) add(s.uuid, `   ${s.name}`);
    opts.push("</optgroup>");
  }

  // Referenz zeigt auf gelöschte Playlist? Trotzdem anzeigen, damit nichts still verloren geht.
  if (current && !["none", "stop"].includes(current) && !resolveTarget(current)) {
    add(current, t("options.missing"));
  }
  return opts.join("");
}

/* -------------------------------------------- */
/*  Musik-Steuerung                             */
/* -------------------------------------------- */

const MusicSwitcher = {
  lastKey: null,
  queue: Promise.resolve(),

  /** Welche Musik sollte gerade laufen? */
  desired() {
    const scene = game.scenes.active;
    if (!scene) return null;

    const inCombat = game.combats.some(
      (c) => c.started && (!c.scene || c.scene.id === scene.id)
    );
    const mode = inCombat ? "combat" : "explore";

    let ref = scene.getFlag(ID, mode) ?? "";
    if (!ref) ref = setting(mode === "combat" ? "defaultCombat" : "defaultExplore") ?? "";
    if (!ref) ref = "none";

    return { key: `${scene.id}|${mode}|${ref}`, ref, mode };
  },

  /** Prüft den aktuellen Zustand und wechselt bei Bedarf die Musik. */
  evaluate({ force = false } = {}) {
    if (!isResponsibleGM()) return;
    if (!setting("enabled")) return;

    const d = this.desired();
    if (!d) return;
    if (!force && d.key === this.lastKey) return;
    this.lastKey = d.key;

    log(`Zustand: ${d.mode} → ${d.ref}`);
    this.queue = this.queue
      .then(() => this.switchTo(d.ref))
      .catch((err) => console.error(`${ID} | Fehler beim Musikwechsel`, err));
    return this.queue;
  },

  /** Alle Tracks, die ausgeblendet werden sollen. */
  collectFadeOut(target) {
    const keep = new Set();
    if (isPlaylistDoc(target)) target.sounds.forEach((s) => keep.add(s.id));
    else if (target) keep.add(target.id);

    const scope = setting("fadeScope");
    const result = [];
    for (const pl of game.playlists) {
      if (scope === "music" && (pl.channel ?? "music") !== "music") continue;
      if (scope === "managed" && !pl.getFlag(ID, "managed")) continue;
      for (const s of pl.sounds) {
        if (s.playing && !keep.has(s.id)) result.push(s);
      }
    }
    return result;
  },

  async switchTo(ref) {
    if (ref === "none") return;

    const target = resolveTarget(ref);
    if (ref !== "stop" && !target) {
      ui.notifications.warn(t("notify.missing"));
      return;
    }

    const alreadyPlaying = target ? !!target.playing : true;
    const toFade = this.collectFadeOut(target);
    if (alreadyPlaying && !toFade.length) return;

    const ms = Math.max(0, Number(setting("fadeDuration")) || 0) * 1000;
    const crossfade = setting("transition") === "crossfade";

    const fadeOutPromise = this.fadeOut(toFade, ms);
    if (!crossfade) await fadeOutPromise;

    const fadeInPromise = target && !alreadyPlaying ? this.play(target, ms) : null;
    await Promise.all([fadeOutPromise, fadeInPromise]);
  },

  /** Blendet die Tracks aus (auf allen Clients) und stoppt sie danach. */
  async fadeOut(sounds, ms) {
    if (!sounds.length) return;

    const groups = new Map();
    for (const s of sounds) {
      const pl = s.parent;
      if (!groups.has(pl.id)) groups.set(pl.id, { pl, sounds: [] });
      groups.get(pl.id).sounds.push(s);
    }

    if (ms > 0) {
      const stamp = Date.now();
      await Promise.all(
        [...groups.values()].map(({ pl, sounds }) =>
          pl.updateEmbeddedDocuments(
            "PlaylistSound",
            sounds.map((s) => ({ _id: s.id, [`${FLAG}.fadeOut`]: { duration: ms, stamp } }))
          )
        )
      );
      await wait(ms + 150);
    }

    await Promise.all(
      [...groups.values()].map(({ pl, sounds }) => {
        const ids = new Set(sounds.map((s) => s.id));
        const stillPlaying = pl.sounds.some((s) => s.playing && !ids.has(s.id));
        return pl.update({
          playing: stillPlaying,
          [`${FLAG}.managed`]: stillPlaying ? (pl.getFlag(ID, "managed") ?? null) : null,
          sounds: sounds.map((s) => ({ _id: s.id, playing: false, [`${FLAG}.fadeOut`]: null }))
        });
      })
    );
  },

  /** Startet eine Playlist oder einen einzelnen Track mit Einblenden. */
  async play(target, ms) {
    const pl = isPlaylistDoc(target) ? target : target.parent;
    const simultaneous = pl.mode === CONST.PLAYLIST_MODES.SIMULTANEOUS;

    let sounds;
    if (!isPlaylistDoc(target)) sounds = [target];
    else if (simultaneous) sounds = [...pl.sounds];
    else {
      const first = pl.playbackOrder?.[0];
      sounds = first ? [pl.sounds.get(first)].filter(Boolean) : [];
    }
    if (!sounds.length) {
      ui.notifications.warn(t("notify.empty"));
      return;
    }
    const ids = new Set(sounds.map((s) => s.id));

    // Fade-Dauer kurzzeitig setzen (Originalwert wird gemerkt)
    if (ms > 0) {
      await pl.updateEmbeddedDocuments(
        "PlaylistSound",
        sounds.map((s) => ({
          _id: s.id,
          fade: ms,
          [`${FLAG}.origFade`]: s.getFlag(ID, "origFade") ?? { value: s._source.fade ?? null }
        }))
      );
    }

    // Starten – wie Foundrys eigenes "Abspielen"
    const soundUpdates = simultaneous
      ? sounds.map((s) => ({ _id: s.id, playing: true, pausedTime: null }))
      : pl.sounds.map((s) => ({
          _id: s.id,
          playing: ids.has(s.id),
          ...(ids.has(s.id) ? { pausedTime: null } : {})
        }));
    await pl.update({ playing: true, [`${FLAG}.managed`]: true, sounds: soundUpdates });

    // Original-Fade wiederherstellen, wenn das Einblenden durch ist
    if (ms > 0) {
      await wait(ms + 1000);
      await restoreFades(pl, ids);
    }
  }
};

/** Setzt die ursprüngliche Fade-Einstellung der Tracks zurück. */
async function restoreFades(pl, onlyIds = null) {
  const updates = [];
  for (const s of pl.sounds) {
    if (onlyIds && !onlyIds.has(s.id)) continue;
    const orig = s.getFlag(ID, "origFade");
    if (!orig) continue;
    updates.push({ _id: s.id, fade: orig.value ?? null, [`${FLAG}.origFade`]: null });
  }
  if (updates.length) await pl.updateEmbeddedDocuments("PlaylistSound", updates);
}

/** Nach Absturz/Neuladen hängengebliebene Markierungen aufräumen. */
async function cleanup() {
  for (const pl of game.playlists) {
    await restoreFades(pl);
    const stuck = pl.sounds.filter((s) => s.getFlag(ID, "fadeOut"));
    if (stuck.length) {
      await pl.updateEmbeddedDocuments(
        "PlaylistSound",
        stuck.map((s) => ({ _id: s.id, playing: false, [`${FLAG}.fadeOut`]: null }))
      );
    }
  }
}

/* -------------------------------------------- */
/*  Einstellungen                               */
/* -------------------------------------------- */

Hooks.once("init", () => {
  const reevaluate = () => MusicSwitcher.evaluate({ force: true });

  game.settings.register(ID, "enabled", {
    name: `${ID}.settings.enabled.name`,
    hint: `${ID}.settings.enabled.hint`,
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
    onChange: reevaluate
  });

  game.settings.register(ID, "defaultExplore", {
    name: `${ID}.settings.defaultExplore.name`,
    hint: `${ID}.settings.defaultExplore.hint`,
    scope: "world",
    config: true,
    type: String,
    default: "",
    onChange: reevaluate
  });

  game.settings.register(ID, "defaultCombat", {
    name: `${ID}.settings.defaultCombat.name`,
    hint: `${ID}.settings.defaultCombat.hint`,
    scope: "world",
    config: true,
    type: String,
    default: "",
    onChange: reevaluate
  });

  game.settings.register(ID, "fadeDuration", {
    name: `${ID}.settings.fadeDuration.name`,
    hint: `${ID}.settings.fadeDuration.hint`,
    scope: "world",
    config: true,
    type: Number,
    range: { min: 0, max: 15, step: 0.5 },
    default: 3
  });

  game.settings.register(ID, "transition", {
    name: `${ID}.settings.transition.name`,
    hint: `${ID}.settings.transition.hint`,
    scope: "world",
    config: true,
    type: String,
    choices: {
      sequential: `${ID}.settings.transition.sequential`,
      crossfade: `${ID}.settings.transition.crossfade`
    },
    default: "sequential"
  });

  game.settings.register(ID, "fadeScope", {
    name: `${ID}.settings.fadeScope.name`,
    hint: `${ID}.settings.fadeScope.hint`,
    scope: "world",
    config: true,
    type: String,
    choices: {
      music: `${ID}.settings.fadeScope.music`,
      managed: `${ID}.settings.fadeScope.managed`,
      all: `${ID}.settings.fadeScope.all`
    },
    default: "music"
  });
});

/* -------------------------------------------- */
/*  Ausblenden auf jedem Client                 */
/* -------------------------------------------- */

Hooks.on("updatePlaylistSound", (sound, changed) => {
  const fade = foundry.utils.getProperty(changed, `${FLAG}.fadeOut`);
  if (!fade?.duration) return;
  const s = sound.sound;
  if (!s?.playing) return;
  try {
    s.fade(0, { duration: fade.duration });
  } catch (err) {
    console.warn(`${ID} | Ausblenden fehlgeschlagen`, err);
  }
});

/* -------------------------------------------- */
/*  Auslöser                                    */
/* -------------------------------------------- */

const scheduleEvaluate = foundry.utils.debounce(() => MusicSwitcher.evaluate(), 300);

Hooks.once("ready", async () => {
  const mod = game.modules.get(ID);
  if (mod) {
    mod.api = {
      /** Musik sofort neu prüfen und ggf. wechseln */
      refresh: () => MusicSwitcher.evaluate({ force: true }),
      /** Automatik an/aus schalten */
      toggle: async () => {
        const v = !setting("enabled");
        await game.settings.set(ID, "enabled", v);
        ui.notifications.info(v ? t("notify.enabled") : t("notify.disabled"));
        return v;
      }
    };
  }

  if (!isResponsibleGM()) return;
  try {
    await cleanup();
  } catch (err) {
    console.warn(`${ID} | Aufräumen fehlgeschlagen`, err);
  }
  MusicSwitcher.evaluate({ force: true });
});

Hooks.on("updateScene", (scene, changed) => {
  if ("active" in changed || foundry.utils.hasProperty(changed, FLAG)) scheduleEvaluate();
});
Hooks.on("createCombat", () => scheduleEvaluate());
Hooks.on("updateCombat", (combat, changed) => {
  if ("round" in changed || "scene" in changed || "active" in changed) scheduleEvaluate();
});
Hooks.on("deleteCombat", () => scheduleEvaluate());

/* -------------------------------------------- */
/*  Oberfläche: Szenen-Konfiguration            */
/* -------------------------------------------- */

Hooks.on("renderSceneConfig", (app, html) => {
  if (!game.user.isGM) return;
  const root = html instanceof HTMLElement ? html : html?.[0];
  if (!root || root.querySelector(`.${ID}-fieldset`)) return;

  const scene = app.document;
  const tab =
    root.querySelector('.tab[data-tab="ambience"]') ??
    root.querySelector('.tab[data-tab="basics"]') ??
    root.querySelector("form") ??
    root;

  const fs = document.createElement("fieldset");
  fs.classList.add(`${ID}-fieldset`);
  fs.innerHTML = `
    <legend><i class="fa-solid fa-music"></i> ${escapeHTML(t("scene.legend"))}</legend>
    <p class="hint">${escapeHTML(t("scene.hint"))}</p>
    <div class="form-group">
      <label>${escapeHTML(t("scene.explore"))}</label>
      <div class="form-fields">
        <select name="${FLAG}.explore">${buildOptions(scene.getFlag(ID, "explore"), { forScene: true })}</select>
      </div>
    </div>
    <div class="form-group">
      <label>${escapeHTML(t("scene.combat"))}</label>
      <div class="form-fields">
        <select name="${FLAG}.combat">${buildOptions(scene.getFlag(ID, "combat"), { forScene: true })}</select>
      </div>
    </div>`;
  tab.append(fs);
});

/* -------------------------------------------- */
/*  Oberfläche: Moduleinstellungen              */
/* -------------------------------------------- */

Hooks.on("renderSettingsConfig", (app, html) => {
  const root = html instanceof HTMLElement ? html : html?.[0];
  if (!root) return;
  for (const key of ["defaultExplore", "defaultCombat"]) {
    const input = root.querySelector(`[name="${ID}.${key}"]`);
    if (!input || input.tagName === "SELECT") continue;
    const select = document.createElement("select");
    select.name = input.name;
    select.innerHTML = buildOptions(setting(key));
    input.replaceWith(select);
  }
});
