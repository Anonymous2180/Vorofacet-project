# VoroFacet

Anonymous research project page with interactive reconstruction comparisons.

The static page loads its model catalog from the sibling GitHub Pages repository
configured in `model-source.json`. No build step, backend, or external CDN is used.
Model geometry is unchanged; gzip chunks are concatenated before decompression.

Third-party Three.js code and its MIT license are retained under `vendor/three/`.
