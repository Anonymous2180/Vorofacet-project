// Decode without blocking orbit controls, scrolling, or the loading indicators.
// Coordinates and face order are preserved exactly; transfer, don't clone, arrays.
self.onmessage = async ({data:{chunks, method}}) => {
  try {
    const blob = new Blob(chunks);
    let buffer;
    if (method.encoding === 'gzip' && chunks[0][0] === 0x1f && chunks[0][1] === 0x8b) {
      if (!self.DecompressionStream) throw new Error('Compressed mesh decoding is unavailable.');
      buffer = await new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    } else buffer = await blob.arrayBuffer();
    if (method.uncompressedBytes && buffer.byteLength !== method.uncompressedBytes) throw new Error('Model data length does not match the verified export.');
    const head = new TextDecoder().decode(new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 16384)));
    const end = head.match(/end_header\r?\n/);
    if (!end) throw new Error('Invalid PLY header.');
    const offset = end.index + end[0].length;
    const header = head.slice(0, offset);
    const vertex = header.match(/element vertex (\d+)\r?\n([\s\S]*?)(?=element |end_header)/);
    const face = header.match(/element face (\d+)\r?\n([\s\S]*?)(?=element |end_header)/);
    const properties = vertex?.[2].trim().split(/\r?\n/).filter(line => !line.startsWith('comment'));
    const simple = /format binary_little_endian 1.0/.test(header) && properties?.length === 3 &&
      properties.every((line, i) => new RegExp('^property (float|float32) ' + ['x','y','z'][i] + '$').test(line)) &&
      /^property list (uchar|uint8) (int|uint|int32|uint32) vertex_indices\s*$/.test(face?.[2].trim() || '');
    if (!simple) { self.postMessage({buffer}, [buffer]); return; }
    const vertices = Number(vertex[1]), faces = Number(face[1]);
    if (vertices !== method.vertices || faces !== method.faces) throw new Error('Mesh counts do not match the verified export.');
    const faceOffset = offset + vertices * 12;
    if (faceOffset + faces * 13 !== buffer.byteLength) throw new Error('Unexpected binary PLY data length.');
    const positions = new Float32Array(buffer.slice(offset, faceOffset));
    const indices = new Uint32Array(faces * 3);
    const view = new DataView(buffer);
    for (let f = 0; f < faces; f++) {
      const cursor = faceOffset + f * 13;
      if (view.getUint8(cursor) !== 3) throw new Error('Only triangular faces are supported.');
      for (let c = 0; c < 3; c++) {
        const index = view.getUint32(cursor + 1 + c * 4, true);
        if (index >= vertices) throw new Error('Invalid triangle index.');
        indices[f * 3 + c] = index;
      }
    }
    if (positions.some(value => !Number.isFinite(value))) throw new Error('Non-finite vertex coordinates.');
    self.postMessage({positions, indices}, [positions.buffer, indices.buffer]);
  } catch (error) { self.postMessage({error:error.message}); }
};
