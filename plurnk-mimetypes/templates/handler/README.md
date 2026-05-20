# {{PACKAGE_NAME}}

`{{MIMETYPE}}` mimetype handler for [plurnk-service](https://github.com/plurnk/plurnk-service).

## Installation

```bash
npm install {{PACKAGE_NAME}}
```

plurnk-service discovers this handler automatically — at boot it scans installed `@plurnk/plurnk-mimetypes-*` packages and reads each one's `package.json` `plurnk` block.

## Development

```bash
npm install
npm run build
npm test
```

Implement `extract(content)` in `src/{{CLASS_NAME}}.ts` to return the structural declarations specific to `{{MIMETYPE}}`. The framework derives `symbols`, `preview`, and `validate` from this single method by default.

## License

MIT
