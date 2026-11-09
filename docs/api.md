# Bifrost dashboard API

The dashboard stores its apps and groups in a SQLite database and exposes them through a small JSON API. The dashboard's management panel uses this API, and so can any other tool, such as a fleet manager.

The API has no authentication. Anyone who can reach the dashboard can change it. Keep the listener on a local interface, and expose it only through a trusted reverse proxy or local network.

This is a deliberate boundary for a single-user tool behind Caddy. Authentication and SVG or CSP hardening of uploaded icons are out of scope; reviews should not raise them. Cheap cross-site guards, such as requiring `Content-Type: application/json` on writes, are in scope.

All paths are relative to the dashboard's root. The examples use `http://127.0.0.1:4310`, the default listener of `npm start`.

## Concepts

- An **app** is a launcher entry: a name, a URL, and an optional icon.
- A **group** is a named, ordered section of apps. Each app belongs to at most one group.
- An app without a group is **ungrouped**. Ungrouped apps appear after all groups.
- Groups have a position among groups. Apps have a position within their group or within the ungrouped list. New apps and new groups are added at the end.

## Objects

### App

```json
{
  "id": 7,
  "name": "Photos",
  "url": "https://photos.example.com/",
  "icon": "icons/d4dc56669143034f31aa309635d4113d9ad76a02b1739da22c965ed2049be9e6.svg",
  "groupId": 2
}
```

| Field | Type | Notes |
| --- | --- | --- |
| `id` | integer | Assigned by the server. |
| `name` | string | 1 to 100 Unicode code points after trimming whitespace. |
| `url` | string | Absolute `http` or `https` URL without embedded credentials, at most 2048 characters after normalization. The server returns the normalized form, for example with a trailing `/` after a bare host. |
| `icon` | string or `null` | Path of the uploaded icon, relative to the dashboard root. `null` means the launcher shows the app's initials. |
| `groupId` | integer or `null` | `null` means ungrouped. |

### Group

```json
{ "id": 2, "name": "Media & files", "apps": [] }
```

| Field | Type | Notes |
| --- | --- | --- |
| `id` | integer | Assigned by the server. |
| `name` | string | 1 to 60 Unicode code points after trimming. Names are unique under Unicode case folding with NFKC normalization, so `STRASSE` and `straße` conflict. |
| `apps` | App array | The group's apps in display order. |

### Catalog

```json
{
  "revision": 42,
  "groups": [
    { "id": 2, "name": "Media & files", "apps": [ { "id": 7, "name": "Photos", "url": "https://photos.example.com/", "icon": null, "groupId": 2 } ] }
  ],
  "ungrouped": [
    { "id": 9, "name": "Miniflux", "url": "https://news.example.com/", "icon": null, "groupId": null }
  ]
}
```

| Field | Type | Notes |
| --- | --- | --- |
| `revision` | integer | Increases by one with every successful change to any app, group, icon, or layout. `PUT /api/layout` must send the revision of the catalog it was based on. |
| `groups` | Group array | In display order. |
| `ungrouped` | App array | In display order. |

Each `apps` array is also in display order.

### Errors

Failed requests return a JSON body with a readable message:

```json
{ "error": "url must be an absolute http or https URL without credentials." }
```

| Status | Meaning |
| --- | --- |
| `400` | The body is not valid JSON, has an unknown field, or has an invalid value. |
| `404` | The route, app, or group does not exist, or a path ID is not a positive safe integer. |
| `405` | The method is not allowed for the route. The `Allow` header lists supported methods. |
| `409` | A group with that name already exists, or a layout's `revision` is not the current revision or its IDs do not match the current apps and groups. Nothing was changed. |
| `413` | The body is too large. JSON bodies are limited to 64 KiB, and icons to 1 MiB. |
| `415` | The icon has an unsupported content type, or a JSON endpoint has a missing or non-JSON content type. |

## Endpoints

| Method and path | Purpose | Success |
| --- | --- | --- |
| `GET /api/catalog` | Read every group and app in display order. | `200` Catalog |
| `POST /api/apps` | Add an app at the end of its group. | `201` App |
| `PATCH /api/apps/{id}` | Change an app's name, URL, or group. | `200` App |
| `DELETE /api/apps/{id}` | Remove an app. | `204` |
| `PUT /api/apps/{id}/icon` | Upload or replace an app's icon. | `200` App |
| `DELETE /api/apps/{id}/icon` | Remove an app's icon. | `200` App |
| `POST /api/groups` | Add a group at the end. | `201` Group |
| `PATCH /api/groups/{id}` | Rename a group. | `200` Group |
| `DELETE /api/groups/{id}` | Remove a group and keep its apps. | `204` |
| `PUT /api/layout` | Set the order of all groups and apps in one step. | `200` Catalog |

Request bodies for `POST`, `PATCH`, and `PUT /api/layout` are JSON objects and require `Content-Type: application/json`. Parameters such as `; charset=utf-8` are allowed. Fields that are not listed for an endpoint are rejected with `400`. Both app and group `PATCH` bodies must contain at least one field; `{}` returns `400` with `Body must contain at least one field.`

Responses with status `204` have no body and no `Content-Type` header.

### Read the catalog

```sh
curl -s http://127.0.0.1:4310/api/catalog
```

Responses use `Cache-Control: no-cache`. The launcher reads this endpoint on every page load.

### Add an app

Fields: `name` and `url` are required. `groupId` is optional and defaults to `null`.

```sh
curl -s -X POST http://127.0.0.1:4310/api/apps \
  -H 'Content-Type: application/json' \
  -d '{"name": "Photos", "url": "https://photos.example.com", "groupId": 2}'
```

The response is the new App with status `201`. An unknown `groupId` returns `404`.

### Change an app

Send only the fields to change: any of `name`, `url`, and `groupId`. Moving an app to another group, or to `null`, places it at the end of that group.

```sh
curl -s -X PATCH http://127.0.0.1:4310/api/apps/7 \
  -H 'Content-Type: application/json' \
  -d '{"name": "Photos", "groupId": null}'
```

### Remove an app

```sh
curl -s -X DELETE http://127.0.0.1:4310/api/apps/7
```

The server also deletes the app's icon file when no other app uses it.

### Upload an icon

Send the image bytes as the request body, with the image's content type. Supported types are `image/svg+xml`, `image/png`, `image/webp`, `image/jpeg`, `image/gif`, `image/x-icon`, and `image/vnd.microsoft.icon`. The limit is 1 MiB.

```sh
curl -s -X PUT http://127.0.0.1:4310/api/apps/7/icon \
  -H 'Content-Type: image/svg+xml' \
  --data-binary @photos.svg
```

The server names the file `icons/<sha256 hex>.<extension>`, using all 64 hexadecimal digits of the content hash. A replaced icon gets a new path, so browsers never show a stale copy. The response is the updated App. Uploading identical bytes reuses the existing file and keeps the first upload's extension, even when the content type changes.

To return to initials:

```sh
curl -s -X DELETE http://127.0.0.1:4310/api/apps/7/icon
```

### Add, rename, and remove groups

```sh
curl -s -X POST http://127.0.0.1:4310/api/groups \
  -H 'Content-Type: application/json' \
  -d '{"name": "Media & files"}'

curl -s -X PATCH http://127.0.0.1:4310/api/groups/2 \
  -H 'Content-Type: application/json' \
  -d '{"name": "Media"}'

curl -s -X DELETE http://127.0.0.1:4310/api/groups/2
```

Removing a group never removes apps. Its apps move to the end of the ungrouped list, in their existing order.

### Reorder everything

`PUT /api/layout` sets the order of groups, the order of apps, and each app's group in one atomic step. The body has three required fields:

- `revision`: the `revision` of the Catalog the layout was built from.
- `groups`: every existing group exactly once, each with its apps in order.
- `ungrouped`: the ungrouped apps in order.

Every existing app appears exactly once across `groups` and `ungrouped`.

```sh
curl -s -X PUT http://127.0.0.1:4310/api/layout \
  -H 'Content-Type: application/json' \
  -d '{"revision": 42, "groups": [{"id": 3, "apps": [12, 7]}, {"id": 2, "apps": []}], "ungrouped": [9]}'
```

The response is the new Catalog, with the new revision. A missing or invalid `revision` returns `400`.

The server changes nothing and returns `409` in these cases:

- `revision` is not the current revision. Another change was made after the catalog was read, for example a reorder or a group change by another client. The error is `The catalog changed since it was read. Read it again and retry.`
- The body names a nonexistent app or group, leaves one out, or repeats an ID.

After a `409`, read the catalog again, rebuild the layout from it, and retry. The revision check keeps a layout built from an old catalog from silently undoing changes it never saw. Other endpoints do not take a revision; the last write to a field wins.

To move a single app between groups without listing the whole layout, use `PATCH /api/apps/{id}` with a new `groupId`.

## Example: synchronize from a fleet manager

A tool that manages apps can make the dashboard match its own list:

1. Read `GET /api/catalog` and index the apps by `url`.
2. For each desired app that is missing, `POST /api/apps`. For each app whose name or group differs, `PATCH /api/apps/{id}`.
3. Upload icons with `PUT /api/apps/{id}/icon` for apps that are new or whose icon changed.
4. `DELETE /api/apps/{id}` for each app the tool manages that should no longer exist.
5. To set an exact order, read `GET /api/catalog` again, build the layout from that response, and send it with that response's `revision` to `PUT /api/layout`. On `409`, repeat this step.

Steps 2 to 4 need no revision. Each one changes the revision, so build a layout only after them.

Only remove apps the tool created, for example by tracking their IDs or URLs. People can also add apps through the dashboard.

## Storage

The server keeps its state in the data directory, set by `BIFROST_DATA_DIR`. Relative paths resolve from the application root in both production and development:

- `bifrost.sqlite`: the database. Opening a database from an earlier version upgrades its schema in place and keeps its data.
- `icons/`: uploaded icons, served at `/icons/`.

When the server creates a new database and the data directory contains a legacy `apps.json`, it imports those apps once, ungrouped and in alphabetical order. A leading UTF-8 BOM is accepted. Legacy icon URLs are resolved against the catalog location. An icon is kept only when its resolved path names one existing file directly under `icons/`, regardless of the URL's origin, and the file name uses only letters, digits, `_`, `-`, and `.` (not first). Rename other icon files before the import. Other icon paths are discarded.

An invalid legacy file stops startup until it is fixed or removed. The error names `apps.json` and, for an invalid entry, its one-based app number. Import is all-or-nothing; a corrected file can be imported on the next start. Later restarts after a successful import never import again.
