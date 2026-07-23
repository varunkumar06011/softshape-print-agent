# SoftShape Driver Plugins

Drop `.ts` or `.js` files here to add external device drivers without modifying
the Runtime core. Each file must export a **default class** that implements the
`Driver` interface from `../types.ts`.

## Quick Start

1. Create a file in this directory, e.g. `my-scale.ts`:

```typescript
import { BaseDriver } from "../types.ts";

export default class MyScale extends BaseDriver {
  readonly name = "my-scale";
  readonly type = "scale" as const;

  async initialize(): Promise<void> {
    // Open serial port, connect to device, etc.
    this.setState("READY");
  }

  async shutdown(): Promise<void> {
    this.setState("STOPPING");
    this.setState("OFFLINE");
  }
}
```

2. Hot-reload without restarting the Runtime:

```
POST http://localhost:3101/api/edge/drivers/reload
Authorization: Bearer <runtime-token>
```

3. Verify it loaded:

```
GET http://localhost:3101/api/edge/drivers
```

## Rules

- **`name`** must be unique. If two plugins have the same name, the last one
  loaded wins.
- **`type`** must be one of: `printer`, `payment`, `barcode`, `scale`, `display`.
- **`initialize()`** is called after load. Set the state to `READY` when the
  device is operational.
- **`health()`** is polled periodically by the Device Manager. Return current
  state and any error.
- **`shutdown()`** is called on reload or Runtime exit. Clean up resources.

## File Format

- `.ts` files are supported (Bun transpiles at import time).
- `.js` and `.mjs` files are also supported.
- Only the `default export` is used. Named exports are ignored.
