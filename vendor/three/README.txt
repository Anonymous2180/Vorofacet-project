Three.js r160, MIT license.
Source: https://github.com/mrdoob/three.js/tree/r160
Vendored files: build/three.module.js, examples/jsm/controls/OrbitControls.js, examples/jsm/loaders/PLYLoader.js.
Addon import paths use ./three.module.js for buildless local loading.
OrbitControls has a local, default-off meshLabMouseMapping option: Ctrl/Meta-left pan,
Shift-left pivot-centered dolly (down enlarges), and middle/right pan. Active drags
rebase when modifiers change. Drag dolly is height-normalized and independent of wheel speed.
Local lifecycle fixes safely release pointer captures on cancel/lost capture/blur/dispose,
resume remaining touches, and fix dolly cursor coordinates (mouse Y and touch scroll offset).
This is an independent gesture adaptation, not a port of MeshLab's free-rotation trackball.
LICENSE is retained. No runtime CDN requests.
