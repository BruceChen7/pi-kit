# Zig Simplification Playbook

## Cleanup Heuristics

- Keep control flow explicit; avoid dense inline conditional expressions.
- Use `defer` / `errdefer` to make cleanup paths obvious.
- Keep error unions readable by handling failures near the boundary.
- Split large procedures into helpers by intent, not line count.
- Prefer straightforward ownership flow over hidden state mutation.

## Examples

### 1) Replace Dense Inline Conditionals

#### Before

```zig
const mode = if (is_loading) .loading else if (has_error) .failed else if (is_done) .done else .idle;
```

#### After

```zig
fn resolveMode(is_loading: bool, has_error: bool, is_done: bool) Mode {
    if (is_loading) return .loading;
    if (has_error) return .failed;
    if (is_done) return .done;
    return .idle;
}

const mode = resolveMode(is_loading, has_error, is_done);
```

### 2) Use `defer` / `errdefer` for Error Cleanup

#### Before

```zig
fn loadConfig(allocator: std.mem.Allocator, path: []const u8) !Config {
    const bytes = try std.fs.cwd().readFileAlloc(allocator, path, 1 << 20);

    const parsed = std.json.parseFromSlice(Config, allocator, bytes, .{}) catch |err| {
        allocator.free(bytes);
        return err;
    };

    allocator.free(bytes);
    return parsed.value;
}
```

#### After

```zig
fn loadConfig(allocator: std.mem.Allocator, path: []const u8) !Config {
    const bytes = try std.fs.cwd().readFileAlloc(allocator, path, 1 << 20);
    errdefer allocator.free(bytes);

    const cfg = try std.json.parseFromSliceLeaky(Config, allocator, bytes, .{});
    allocator.free(bytes);
    return cfg;
}
```

### 3) Make Error Mapping Explicit

#### Before

```zig
fn fetchUser(id: u64) !User {
    const raw = repoRead(id) catch return error.UserUnavailable;
    return parseUser(raw) catch return error.UserUnavailable;
}
```

#### After

```zig
fn fetchUser(id: u64) !User {
    const raw = repoRead(id) catch |err| return mapRepoErr(err);
    return parseUser(raw) catch |err| return mapParseErr(err);
}

fn mapRepoErr(err: anyerror) anyerror {
    return switch (err) {
        error.NotFound => error.UserNotFound,
        error.Timeout => error.UserUnavailable,
        else => err,
    };
}

fn mapParseErr(err: anyerror) anyerror {
    return switch (err) {
        error.InvalidFormat => error.UserCorrupt,
        else => err,
    };
}
```

### 4) Split Branchy Functions by Concern

#### Before

```zig
fn buildEndpoint(env: []const u8, region: []const u8, secure: bool) []const u8 {
    if (std.mem.eql(u8, env, "prod")) {
        if (std.mem.eql(u8, region, "us")) {
            return if (secure) "https://api.us.example.com" else "http://api.us.example.com";
        } else {
            return if (secure) "https://api.eu.example.com" else "http://api.eu.example.com";
        }
    }
    return "http://localhost:8080";
}
```

#### After

```zig
fn buildEndpoint(env: []const u8, region: []const u8, secure: bool) []const u8 {
    if (!std.mem.eql(u8, env, "prod")) return "http://localhost:8080";
    if (secure) return secureEndpoint(region);
    return insecureEndpoint(region);
}

fn secureEndpoint(region: []const u8) []const u8 {
    if (std.mem.eql(u8, region, "us")) return "https://api.us.example.com";
    return "https://api.eu.example.com";
}

fn insecureEndpoint(region: []const u8) []const u8 {
    if (std.mem.eql(u8, region, "us")) return "http://api.us.example.com";
    return "http://api.eu.example.com";
}
```
