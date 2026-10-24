# Ascandir - Music Switcher

Foundry-VTT-Modul (v14), das automatisch passende Musik spielt – abhängig von der aktiven Szene und davon, ob gerade gekämpft wird. Beim Wechsel wird das alte Lied sanft leiser und das neue sanft lauter.

## Installation

In Foundry unter **Add-on Modules → Install Module** diese Manifest-URL eintragen:

```
https://github.com/Ascandir/Ascandir---Music-Switcher/releases/latest/download/module.json
```

## Einrichtung (nur Spielleiter)

1. **Moduleinstellungen** (Spieleinstellungen → Module konfigurieren → Ascandir - Music Switcher)
   - *Standard-Musik (kein Kampf)* und *Standard-Kampfmusik*: gelten für alle Szenen ohne eigene Einstellung.
   - *Dauer des Übergangs*: Sekunden für Aus-/Einblenden (Standard 3).
   - *Art des Übergangs*: nacheinander (erst leise, dann wieder laut) oder überblenden.
   - *Welche Musik wird ausgeblendet*: Standard sind alle Playlists im Kanal „Musik“ – Ambience-Playlists im Kanal „Umgebung“ laufen weiter.
2. **Pro Szene**: Szene konfigurieren → Reiter **Ambiente** → Abschnitt **Music Switcher**
   - *Musik ohne Kampf* und *Musik im Kampf*. Wählbar ist eine ganze Playlist (spielt nach ihrem Modus: nacheinander, zufällig, gleichzeitig) oder ein einzelner Track.
   - „Standard“ nimmt die Moduleinstellung, „Nichts ändern“ lässt die aktuelle Musik weiterlaufen, „Musik ausblenden“ sorgt für Stille.

## Wann wird gewechselt?

- Wenn eine andere Szene **aktiviert** wird.
- Wenn auf der aktiven Szene ein **Kampf beginnt** (Runde 1) oder **endet** (Kampf gelöscht/beendet).
- Wenn du die Musik-Einstellungen der aktiven Szene änderst.

Läuft die gewünschte Musik bereits, passiert nichts. Startest du zwischendurch selbst andere Musik, greift das Modul erst beim nächsten Szenen- oder Kampfwechsel wieder ein.

**Tipp:** Das Foundry-eigene Feld „Playlist“ in der Szenen-Konfiguration am besten leer lassen, sonst startet Foundry dort zusätzlich Musik.

## Makros

```js
game.modules.get("ascandir-music-switcher").api.toggle();   // Automatik an/aus
game.modules.get("ascandir-music-switcher").api.refresh();  // sofort neu prüfen
```
