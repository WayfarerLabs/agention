# Changelog

## [0.4.0](https://github.com/WayfarerLabs/agention/compare/v0.3.0...v0.4.0) (2026-11-22)


### Features

* **api:** tell agents that mermaid blocks show as diagrams ([4d2643c](https://github.com/WayfarerLabs/agention/commit/4d2643c0d6fc30eaead55b1d9c419c40c1f1b21a))
* **server:** add agention backup ([0310ff4](https://github.com/WayfarerLabs/agention/commit/0310ff46acb98c3f85dd923ac4ae9fc92604d744))
* **server:** add migration 3 for session groups, tags and message search ([efce1bc](https://github.com/WayfarerLabs/agention/commit/efce1bc3a468bc5d7c390fe098dbcbe6e526e932))
* **server:** count each session's unread threads and the sessions with unread updates ([7f77f47](https://github.com/WayfarerLabs/agention/commit/7f77f4765e95b85a3957ce7a084f7625142eaf38))
* **server:** filter and group the thread list by session group and tag ([6606af6](https://github.com/WayfarerLabs/agention/commit/6606af650392cb9910008ba35d24545bdc262a1e))
* **server:** keep the operator's session groups and tags ([9eabc37](https://github.com/WayfarerLabs/agention/commit/9eabc37c7b441eec2822429aca84a690dd498655))
* **server:** search what messages say in the operator's thread list ([ff5f53f](https://github.com/WayfarerLabs/agention/commit/ff5f53fa73a1293b11be120b6c07c47c8a1ceff1))
* **server:** serve the diagram frame with a policy of its own ([e5d8a88](https://github.com/WayfarerLabs/agention/commit/e5d8a8873da4524dde3a4711f46fc511ff047e4c))
* **server:** voice settings, their environment, and transcription ([8167901](https://github.com/WayfarerLabs/agention/commit/81679018acd64671055dcd0cda95511d4f8f4a7a))
* **web:** a Settings view with passkeys, voice and signing out ([d76ee8f](https://github.com/WayfarerLabs/agention/commit/d76ee8f83c7b5b4746a5db38d793a64da97eca14))
* **web:** dictation in the composer, and reading a message aloud ([afaed89](https://github.com/WayfarerLabs/agention/commit/afaed89c42066b57194bf21aa29d1c100154b6f6))
* **web:** draw mermaid blocks as diagrams in a sandboxed frame ([dc15a79](https://github.com/WayfarerLabs/agention/commit/dc15a797ce2095dea4541b880182b7ee8fb2df9f))
* **web:** filter and fold the thread list by session group and tag ([79fa34b](https://github.com/WayfarerLabs/agention/commit/79fa34b68517fb7f8eba3f95267ca85e3892607a))
* **web:** fold the sessions view by group, with roll-ups, links and a badge ([121f1fc](https://github.com/WayfarerLabs/agention/commit/121f1fcd667d71c6ea17709b847d9ff02920bbe5))
* **web:** keep Send above a phone's keyboard, and the way back under it ([2fee421](https://github.com/WayfarerLabs/agention/commit/2fee42149374c7b33dc7b02cace7484d2bcf854e))
* **web:** organize sessions into groups and tag agents and sessions ([705cf9d](https://github.com/WayfarerLabs/agention/commit/705cf9d11a66a1015eb1ef11e4dee2908a7f44c5))
* **web:** show quiet and stranded in the warning's tone in the thread list ([be9e4ab](https://github.com/WayfarerLabs/agention/commit/be9e4ab2aabc5f1f1f22be905ab802e50ddb9762))


### Bug Fixes

* **bridge:** say when a tunnel leads to a plain-HTTP port instead of the server's origin ([02d912a](https://github.com/WayfarerLabs/agention/commit/02d912a7a0c3f2c1619670f8832ca0ba7ad625c7))
* **plugin:** ask once the operator can act, and offer diagrams in detail ([5cadf92](https://github.com/WayfarerLabs/agention/commit/5cadf920d85381aa6a008ffbed4482d72214b6ec))

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
