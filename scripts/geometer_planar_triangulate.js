#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

async function main() {
  const [requestPath, responsePath, geometerRoot] = process.argv.slice(2);
  if (!requestPath || !responsePath || !geometerRoot) {
    throw new Error("usage: geometer_planar_triangulate.js REQUEST RESPONSE GEOMETER_ROOT");
  }

  const browserDist = path.join(geometerRoot, "dist", "wasm", "browser");
  const createGeometerModule = require(path.join(browserDist, "geometer.js"));
  const module = await createGeometerModule({
    wasmBinary: fs.readFileSync(path.join(browserDist, "geometer.wasm")),
  });
  const request = fs.readFileSync(requestPath);
  const requestPtr = module._malloc(request.length);
  const valueOut = module._malloc(4);
  const valueSizeOut = module._malloc(4);
  const errorOut = module._malloc(4);
  module.HEAPU8.set(request, requestPtr);
  module.HEAPU32[valueOut >> 2] = 0;
  module.HEAPU32[valueSizeOut >> 2] = 0;
  module.HEAPU32[errorOut >> 2] = 0;

  const code = module.ccall(
    "geometer_planar_triangulate_bytes",
    "number",
    ["number", "number", "number", "number", "number"],
    [requestPtr, request.length, valueOut, valueSizeOut, errorOut],
  );
  const valuePtr = module.getValue(valueOut, "*");
  const valueSize = module.getValue(valueSizeOut, "i32");
  const errorPtr = module.getValue(errorOut, "*");
  const error = errorPtr ? module.UTF8ToString(errorPtr) : "";
  const value = valuePtr
    ? Buffer.from(module.HEAPU8.subarray(valuePtr, valuePtr + valueSize))
    : Buffer.alloc(0);

  if (valuePtr) module._geometer_free_bytes(valuePtr);
  if (errorPtr) module._geometer_free_string(errorPtr);
  module._free(requestPtr);
  module._free(valueOut);
  module._free(valueSizeOut);
  module._free(errorOut);

  if (code !== 0) throw new Error(`Geometer triangulation failed (${code}): ${error}`);
  fs.writeFileSync(responsePath, value);
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exit(1);
});
