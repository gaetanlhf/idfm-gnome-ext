<h2 align="center">IDFM GNOME</h2>
<p align="center">Next departures for Île-de-France public transport, right in your GNOME top bar</p>
<p align="center">
    <a href="#about">About</a> •
    <a href="#features">Features</a> •
    <a href="#requirements">Requirements</a> •
    <a href="#installation">Installation</a> •
    <a href="#configuration">Configuration</a> •
    <a href="#how-it-works">How it works</a> •
    <a href="#license">License</a>
</p>

## About

IDFM GNOME shows the next departures of Île-de-France public transport (metro, RER, Transilien, tram, bus, Noctilien, cable, funicular) in the GNOME top bar, using the PRIM / Île-de-France Mobilités API.

It is built around one idea: you watch a line in a given direction only when it matters. Each watched line has its own display schedule (days and time ranges), so your evening metro shows up around leaving time and nothing clutters the bar the rest of the day. Perfect for knowing exactly when to leave the office.

## Features

- **Line, stop and direction**: Watch a specific stop, line and direction. Both directions of a line can be watched independently.
- **Realtime**: Departures come from the SIRI "Prochains passages" feed, the same source as the screens on the platforms, for every mode including metro and Transilien.
- **Scheduled display**: Each watched line has several display slots (days and time ranges). The line only appears during its slots.
- **Rotating top bar**: When several lines are active, the bar cycles through them with an animated transition and a coloured line badge in the style of the IDFM app. Scroll on the indicator to switch manually.
- **Imminent departures**: Departures at or below a chosen threshold are highlighted in red, with optional blinking (smooth or strong).
- **Quiet when idle**: Outside every slot the indicator shows the IDFM icon, or hides entirely (option). The menu always lists every watched line.
- **Quota friendly**: The API is only polled while a line is within a slot, and lines sharing the same physical stop share a single call.

## Requirements

- GNOME Shell 46 to 50.
- A free PRIM API key:
    1. Create an account at [prim.iledefrance-mobilites.fr](https://prim.iledefrance-mobilites.fr/).
    2. Under **My authentication tokens**, generate an API key.
    3. Paste it in the extension preferences, API tab.

## Installation

```bash
git clone https://github.com/gaetanlhf/idfm-gnome-ext.git
cd idfm-gnome-ext
./install.sh
```

Then log out and back in (Wayland), and enable the extension:

```bash
gnome-extensions enable idfm-gnome-ext@gaetanlhf.fr
gnome-extensions prefs idfm-gnome-ext@gaetanlhf.fr
```

`install.sh` compiles the GSettings schema and the translations (with `msgfmt` if present, otherwise a bundled Python compiler), then copies everything to `~/.local/share/gnome-shell/extensions/`. No build toolchain required.

## Configuration

```bash
gnome-extensions prefs idfm-gnome-ext@gaetanlhf.fr
```

- **API**: your PRIM key.
- **Display**: refresh interval, departures shown, rotation timing and animation, hide-when-idle, and highlighting of imminent departures (red, with optional blinking).
- **Next departures**: add a line (pick a stop, then a line, then a direction) and set its display slots.

## How it works

- Departures come from SIRI stop-monitoring at stop-area level.
- For SNCF stations (RER/Transilien), the correct rail stop-area is resolved from the public `zones-d-arrets` dataset, because the multimodal zone returned by search does not carry SNCF realtime data.
- Directions are matched by normalised terminus name, since SIRI destinations are platform-level while route directions are zone-level.
- Stop and line lookups use the PRIM Navitia API; directions come from the SIRI feed (falling back to Navitia routes). These lookups are only performed while configuring.

## License

This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.

This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for more details.

You should have received a copy of the GNU General Public License along with this program. If not, see http://www.gnu.org/licenses/.
