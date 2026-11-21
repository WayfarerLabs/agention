# Changelog

## [0.3.1](https://github.com/WayfarerLabs/agention/compare/v0.3.0...v0.3.1) (2026-11-21)


### Bug Fixes

* **bridge:** say when a tunnel leads to a plain-HTTP port instead of the server's origin ([02d912a](https://github.com/WayfarerLabs/agention/commit/02d912a7a0c3f2c1619670f8832ca0ba7ad625c7))

## [0.3.0](https://github.com/WayfarerLabs/agention/compare/v0.2.1...v0.3.0) (2026-11-21)


### Features

* **bridge:** add session_update, through which a session reports its status ([3154596](https://github.com/WayfarerLabs/agention/commit/3154596af80ad2b64c95700bda33871ff92ddc83))
* **bridge:** open the bridge's connections at AGENTION_CONNECT ([18674ee](https://github.com/WayfarerLabs/agention/commit/18674ee61b80c98fbc3802f94cde1e0a1e0040e1))
* **bridge:** state the agent API version and refuse an older server ([8b0bc3c](https://github.com/WayfarerLabs/agention/commit/8b0bc3c658a73666c9b8244dfcad66384323d39a))
* **plugin:** have agents report their session's state ([e75ad60](https://github.com/WayfarerLabs/agention/commit/e75ad608f4b7da42a84fc50ecec13248d975f758))
* **server:** log each session's status and let the operator start threads on it ([3efe992](https://github.com/WayfarerLabs/agention/commit/3efe992f29b244db1ecf9f07fadb82d48532288f))
* **server:** state the agent API version and refuse a bridge outside it ([96c481b](https://github.com/WayfarerLabs/agention/commit/96c481bc5f0af085a2ef558b38cc9b830ac254c1))
* **web:** say why a stranded thread's session has not read it ([db366dc](https://github.com/WayfarerLabs/agention/commit/db366dcaa9655cf42515a2bae6f9eddbf38c59b7))
* **web:** show every session in one view, and start threads there ([4c7e528](https://github.com/WayfarerLabs/agention/commit/4c7e5287dc4f9692a29e2e1da39c787be037dc0e))


### Bug Fixes

* **web:** clear a staged answer from its ask card ([e8de103](https://github.com/WayfarerLabs/agention/commit/e8de103910baf693d9e405a4b6288e6e3afa4a1b))
* **web:** jump to unread messages and open asks from the thread's head ([74073e4](https://github.com/WayfarerLabs/agention/commit/74073e461c366279b8676015cc6ca7712cb370c6))
* **web:** make unread threads and messages stand out from read ones ([fff1f11](https://github.com/WayfarerLabs/agention/commit/fff1f11109a8755fa00ec0237eed8637308f8e10))

## [0.2.1](https://github.com/WayfarerLabs/agention/compare/v0.2.0...v0.2.1) (2026-11-20)


### Bug Fixes

* **bridge:** word the bridge's own errors for the agent ([27c0eb0](https://github.com/WayfarerLabs/agention/commit/27c0eb02d92f82509f42c39809ca983566464bb2))
* give each npm package a README ([477aff0](https://github.com/WayfarerLabs/agention/commit/477aff0e31b205d43455b594a0dfff4db13270ab))

## [0.2.0](https://github.com/WayfarerLabs/agention/compare/v0.1.0...v0.2.0) (2026-11-20)


### Features

* **bridge:** tell agent hosts to ask through Agention, and how answers reach them ([a8b6d13](https://github.com/WayfarerLabs/agention/commit/a8b6d135b49948a6f572f6041440fbf57dc1f298))


### Bug Fixes

* **plugin:** rework the skill around attention, the bridge and the operator's word ([b3981a7](https://github.com/WayfarerLabs/agention/commit/b3981a710da5c484c43cdbdc7461b70c3f60d43f))

## 0.1.0 (2026-11-19)


### Features

* **api:** define the HTTP API contract ([1e52603](https://github.com/WayfarerLabs/agention/commit/1e526038fd3c66ea0b17ae26ed0d1867ffe1c964))
* **bridge:** add the agent bridge ([89d4f5c](https://github.com/WayfarerLabs/agention/commit/89d4f5cec4d5931acc67d3a73651daadfefcf9e4))
* **plugin:** generate agent plugins that run the bridge ([bb6e6db](https://github.com/WayfarerLabs/agention/commit/bb6e6dbcebccc84281312c3493e92a4a0c1f19fb))
* **server:** add the Agention server and its agention command ([41f0390](https://github.com/WayfarerLabs/agention/commit/41f0390d13fb7a1f27c6538753770a31fa869c8e))
* **web:** add the operator's web UI ([81e4216](https://github.com/WayfarerLabs/agention/commit/81e421600e6875221251a052ede8ce3578b42fdc))
