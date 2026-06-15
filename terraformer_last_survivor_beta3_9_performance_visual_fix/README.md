# Terraformer: Last Survivor - Beta 3.5 Visual Integration

This build integrates the locked Beta 3 roadmap directly into the code as far as possible with browser/Three.js primitives and generated texture/icon assets.

## Added/Improved

- Much higher ore density: 620 active ore nodes per world.
- Only official ores from the uploaded ore sheet are used: iron, titanium, silicon, cobalt, aluminum, magnesium, uranium, iridium, osmium, super alloy, zirconium, palladium, rhodium, inosium, zeolite, obsidian, prismium, and gold.
- Removed placeholder mineable resources such as ice, stone, carbon, biomass, and generic crystals.
- Ore nodes are small, embedded into the ground, and have larger invisible hit targets so mining is easier.
- Ore inventory icons and world sprites use the generated ore images in `static/assets/ores/`.
- Mining uses the multi-tool with hold-to-mine timing and node depletion/respawn.
- Escape pod rebuilt as a more detailed hexagonal emergency pod with panel plates, scorch marks, windows, solar panels, landing legs, thrusters, interior details, NOVA screen, bunk, and an interior storage crate.
- Escape pod door is automatic: it slides open when the player approaches and closes when they leave.
- Oxygen refills only inside the escape pod or fully breathable atmosphere.
- Storage crate is physically inside the pod and opens with right click; player inventory is shown on the left and container contents on the right.
- Crate transfers work both ways: player to container and container to player.
- Colony station crash rebuilt as a larger orbital-station wreck with broken rings, hull modules, scattered debris, cables, fires, lights, airlock entrances, and automatic station doors.
- Terrain collision/following is active so the player follows hills instead of phasing through the terrain.
- Better astronaut placeholder model with running animation, name tags, first-person default, and V third-person toggle.
- Futuristic mining gun with beam, sparks, glow, and recoil-style movement.

## Important Setup

Run the included `supabase_setup.sql` in Supabase before testing this version.

Default owner login:

- Username: `owner`
- Password: `owner123`

Run locally:

```bash
pip install -r requirements.txt
python app.py
```

Then open:

```text
http://localhost:8000
```

## Notes

The crash station and pod are now far more detailed in code, but they are still generated with Three.js geometry. To look exactly like high-end concept art, the next step would be adding real `.glb`/`.gltf` models and PBR textures.


## Beta 3.8 Planet-Crafter-style playability update

This update moves the project closer to the design list you provided:
- Browser lag reduced: shadows disabled, pixel ratio capped, fewer decorative objects, and ore nodes now use nearby-only rendering.
- Movement speed increased and sprint is smoother.
- Ore spawning expanded while only rendering nearby nodes for performance.
- Planet-Crafter-style resource set added: Iron, Titanium, Silicon, Magnesium, Cobalt, Ice, Aluminum, Iridium, Uranium, Sulfur, Osmium, Super Alloy, Zeolite, and Pulsar Quartz.
- Ore inventory icons are generated in `static/assets/ores/`.
- Terraforming stages are visible: Dead Desert, Blue Sky, Rain, Lakes, Moss, Flora, Trees, and Breathable Life.
- The world sky/ground life changes as terraforming stats improve.
- Starter build menu now places basic machines instead of being a blank placeholder.
- Escape pod oxygen refill is faster and the pod entrance is less blocked.
- Storage and NOVA terminal remain inside the pod.

Run the updated `supabase_setup.sql` before testing.
