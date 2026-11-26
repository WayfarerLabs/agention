# Changelog

## [0.7.0](https://github.com/WayfarerLabs/agention/compare/v0.6.0...v0.7.0) (2026-11-25)


### ⚠ BREAKING CHANGES

* **server:** On the agent API and operator API v1, a thread's `files` totals and its file list (`GET /threads/:thread/files`) cover only the files its live messages carry: a file that only a replaced message carries no longer counts or lists, though the replaced message still reads back with it, and a kept file lists with the replacement that carries it rather than the message that first brought it.
* **server:** On operator API v1, group=session and group=session_group no longer split sessions by topic or carry topics in their roll-ups; group=topic gives what group=session gave before.

### Features

* **api:** carry files on the operator's start of a thread ([9d78584](https://github.com/WayfarerLabs/agention/commit/9d78584de631373c294e1b1a968f4d2b04b12a0f))
* **bridge:** report a status beside thread_create and message_send ([4b38320](https://github.com/WayfarerLabs/agention/commit/4b38320b54739fc87366047bcce43300ec1f2feb))
* filter the thread list by pull request and branch, and show them on rows ([4549858](https://github.com/WayfarerLabs/agention/commit/45498584286f672f791a189ece6ee315d72114cd))
* name pull requests and branches on messages, rolled up for the thread ([a401c58](https://github.com/WayfarerLabs/agention/commit/a401c581e92fa3640188e282b12e3542e5286404)), closes [#146](https://github.com/WayfarerLabs/agention/issues/146)
* select threads in the list and act on them together ([0f4d5c2](https://github.com/WayfarerLabs/agention/commit/0f4d5c29c85957c297dde42182bd7eeb4156605e))
* **server:** color and order groups, keep tags as rows, and group a session on approval ([b228786](https://github.com/WayfarerLabs/agention/commit/b228786b7117d962753ace7564fe97466da4d1ae))
* **server:** group the thread list by session alone, and add a topic grouping ([fd0693a](https://github.com/WayfarerLabs/agention/commit/fd0693a5785b8434b9f183f92708570b5099e8b9)), closes [#134](https://github.com/WayfarerLabs/agention/issues/134)
* **server:** mark an idle session working when it writes, and take a status beside a write ([dcb8850](https://github.com/WayfarerLabs/agention/commit/dcb88503ba56a8d458afe0fc9ad99196f9c33ebe))
* **server:** name the operator API guide in the API documentation ([ef2076f](https://github.com/WayfarerLabs/agention/commit/ef2076fb9f54187fa83644f943a3e332ed72a787))
* **voice:** call the voice prompt Additional context, and drop a prompt Whisper only echoes ([0eb2770](https://github.com/WayfarerLabs/agention/commit/0eb2770646c4cb31f5de46a230557ebf1f530941))
* **web:** add a search box atop the thread list ([b90d14d](https://github.com/WayfarerLabs/agention/commit/b90d14d6023f67e6e908e51b6c52171f79022365))
* **web:** add keyboard shortcuts, listed by ?, with an off switch in Settings ([ad3e526](https://github.com/WayfarerLabs/agention/commit/ad3e5264dec0aa59129d678de9caba06d7b81ef2))
* **web:** attach and dictate wherever a message is written ([2662f82](https://github.com/WayfarerLabs/agention/commit/2662f822ff3412c2c151d4dabd6065745f9a5130))
* **web:** choose where a send goes from an icon, and archive with a toggle beside it ([2f91ff5](https://github.com/WayfarerLabs/agention/commit/2f91ff57c67ce8f8a90e9154f2d01393a73d5a71))
* **web:** copy a message's Markdown from its head ([dcbac06](https://github.com/WayfarerLabs/agention/commit/dcbac06cc7fc26c7680e4fa986afe5cf0e123a94)), closes [#124](https://github.com/WayfarerLabs/agention/issues/124)
* **web:** divide a thread's archived messages from the later ones ([c69a6b1](https://github.com/WayfarerLabs/agention/commit/c69a6b1fe092f9b26be1f7080772b3839571066b))
* **web:** draw the icons from Material Symbols, a little heavier ([0175108](https://github.com/WayfarerLabs/agention/commit/017510864f05e7bb4b0aea5733fba705f8b5e119))
* **web:** fill a desktop's width and tighten spacing with a mouse ([5140810](https://github.com/WayfarerLabs/agention/commit/5140810fe77196a31061625525c8be195caf88b7))
* **web:** group and sort the sessions view, moving groups in their manual order ([ec72f7b](https://github.com/WayfarerLabs/agention/commit/ec72f7b79553a720b2a6238dd36594f2ca70f40b))
* **web:** keep each thread's draft in the browser ([76943db](https://github.com/WayfarerLabs/agention/commit/76943dbe44f383599fbb8bc760bfa9b73a499f59)), closes [#66](https://github.com/WayfarerLabs/agention/issues/66)
* **web:** keep the list's bulk actions in a bar at its foot ([d06821f](https://github.com/WayfarerLabs/agention/commit/d06821f269af20da257c8e17c2437da0f32c27c2))
* **web:** keys to mark threads read or unread and to open the list's head ([25a9cc9](https://github.com/WayfarerLabs/agention/commit/25a9cc9af011183996e5d1eddd2bd0e53f1fb07c))
* **web:** lead the list's head with one row of icons ([6d5e256](https://github.com/WayfarerLabs/agention/commit/6d5e256d59730f5d41c1580a5ccc70447521eaca))
* **web:** let Enter send, with Shift+Enter for a new line ([ea55be9](https://github.com/WayfarerLabs/agention/commit/ea55be9a8691a44232f564d119d6c8c7a80abc0c))
* **web:** link header chips to their threads' filters ([9610e49](https://github.com/WayfarerLabs/agention/commit/9610e49160799f1df18f243b8a31a8c2d0ef1c53))
* **web:** move to the thread above or below, and choose where archiving takes you ([156346c](https://github.com/WayfarerLabs/agention/commit/156346c913ef37277ad99f677c86d2e443154293))
* **web:** pick groups and tags in a labels picker, color them, and order groups in Settings ([4203dad](https://github.com/WayfarerLabs/agention/commit/4203dade15036d93ab81e0e86732087c40cfbbc5))
* **web:** put the list's and the thread's actions in bars at their feet ([fd9c248](https://github.com/WayfarerLabs/agention/commit/fd9c248eac51d0028ef153b7612873c7b7d46980))
* **web:** show the thread list and the open thread side by side at a desktop's width ([2709fd7](https://github.com/WayfarerLabs/agention/commit/2709fd7c36aa4282eb9246276e3375ffa3c41fe1))
* write notes beside any answer on an ask's card ([1f4ed67](https://github.com/WayfarerLabs/agention/commit/1f4ed672de5b9442b2ae5f43ced44ff1efd00814))


### Bug Fixes

* **server:** bound the operator's waits across sessions one credential holds ([b4e2c84](https://github.com/WayfarerLabs/agention/commit/b4e2c847ca867d5af5c3aaea5f2a1975cfc11725))
* **server:** log a file read cut short and drop its connection ([f40f527](https://github.com/WayfarerLabs/agention/commit/f40f527f115c2f7ebdd8f5f15af0fcad5eba8f0d)), closes [#52](https://github.com/WayfarerLabs/agention/issues/52)
* **server:** refuse a local-use NAT64 address as a transcription base URL ([0f04db0](https://github.com/WayfarerLabs/agention/commit/0f04db030f9576359248de6b545c4fd1756e1a26))
* **server:** roll a thread's files up from its live messages only ([92e7412](https://github.com/WayfarerLabs/agention/commit/92e7412b1631527f970577c309bfbca730ad3ab4)), closes [#141](https://github.com/WayfarerLabs/agention/issues/141)
* **web:** ask nothing that needs the session once ending it starts ([1336a63](https://github.com/WayfarerLabs/agention/commit/1336a638c08151a40cfc479d61821bbfca0db20b)), closes [#92](https://github.com/WayfarerLabs/agention/issues/92)
* **web:** count a draft left in the composer from the message a write lands as ([ba819cf](https://github.com/WayfarerLabs/agention/commit/ba819cfc0d304c8058937d912403d80bacd278c4)), closes [#56](https://github.com/WayfarerLabs/agention/issues/56)
* **web:** drop a pending search when the list's view is replaced ([c988484](https://github.com/WayfarerLabs/agention/commit/c98848468e49a232e0e3c061106a26c0ba1b61a0)), closes [#159](https://github.com/WayfarerLabs/agention/issues/159)
* **web:** judge a change of answers by what the page learned while its asks loaded ([d93dfa2](https://github.com/WayfarerLabs/agention/commit/d93dfa2d183111d85ad0a343688bb736bf1e0f8b)), closes [#75](https://github.com/WayfarerLabs/agention/issues/75)
* **web:** judge a stale write by what is staged when its answer comes ([2eb0755](https://github.com/WayfarerLabs/agention/commit/2eb075529267843b06c1a5614cd85a586d60d4ef)), closes [#57](https://github.com/WayfarerLabs/agention/issues/57)
* **web:** judge what is staged by what a landed write did ([c127cb7](https://github.com/WayfarerLabs/agention/commit/c127cb73a1df6b243444b05dade5b74504412645)), closes [#57](https://github.com/WayfarerLabs/agention/issues/57)
* **web:** keep a write's remainder only while its page owns the draft ([f6502b4](https://github.com/WayfarerLabs/agention/commit/f6502b4c4dbe0be31ee43b273965691cdd356c2b)), closes [#108](https://github.com/WayfarerLabs/agention/issues/108)
* **web:** keep focus on Go back after sending as dictation moves it ([7334f48](https://github.com/WayfarerLabs/agention/commit/7334f48dd3087249dc36287b03bd1f93c69d8d9b))
* **web:** keep saying a restored draft left something behind ([89402df](https://github.com/WayfarerLabs/agention/commit/89402dff4731925a6d27f4bf79b06ee264dea75e)), closes [#81](https://github.com/WayfarerLabs/agention/issues/81)
* **web:** keep the approvals section to a line while none waits ([9f8f4f6](https://github.com/WayfarerLabs/agention/commit/9f8f4f6d7b090e1b548167a50e53ef232d0b32d3))
* **web:** keep what a write leaves over an older render's draft ([ec0847b](https://github.com/WayfarerLabs/agention/commit/ec0847b768fdd71c3725bbe3a5df09b2085345a3))
* **web:** land on the thread's heading once it loads ([8ce8487](https://github.com/WayfarerLabs/agention/commit/8ce8487b28df9eace4fa47c158d91ce8e3086cb6)), closes [#130](https://github.com/WayfarerLabs/agention/issues/130)
* **web:** mark a message read once the archive mark covers it ([580b43f](https://github.com/WayfarerLabs/agention/commit/580b43fa7cce01ff23d376bd1f8a4286a2261de4)), closes [#122](https://github.com/WayfarerLabs/agention/issues/122)
* **web:** read what the composer holds as rendered when a write lands ([532159b](https://github.com/WayfarerLabs/agention/commit/532159bf798079aa6fe147c125fd4b307b5d715d))
* **web:** remove a writer's unsent uploads when it goes away ([221a68b](https://github.com/WayfarerLabs/agention/commit/221a68b52830ad62ec08455ac7d73b2e2184cac7)), closes [#136](https://github.com/WayfarerLabs/agention/issues/136)

## [0.6.0](https://github.com/WayfarerLabs/agention/compare/v0.5.0...v0.6.0) (2026-11-23)


### Features

* **bridge:** remind an agent whose session status has gone unreported ([bf4a3c1](https://github.com/WayfarerLabs/agention/commit/bf4a3c132d95ab6bad83155194fcf2f232dafeed)), closes [#59](https://github.com/WayfarerLabs/agention/issues/59)
* show how old a session's status is in the sessions view ([e2a2596](https://github.com/WayfarerLabs/agention/commit/e2a2596e8374a111ef77c84ecb96e72538ffa368)), closes [#59](https://github.com/WayfarerLabs/agention/issues/59)
* **web:** open an attach menu of our own on touch devices ([b2ce308](https://github.com/WayfarerLabs/agention/commit/b2ce308a63799e876925c8d71b88932aff3c0c32)), closes [#48](https://github.com/WayfarerLabs/agention/issues/48)


### Bug Fixes

* **web:** keep the files of a replacement staged while a stale one was under way ([e63a3a9](https://github.com/WayfarerLabs/agention/commit/e63a3a9661091f411e9a3b52b29bb1a34ec573b5))

## [0.5.0](https://github.com/WayfarerLabs/agention/compare/v0.4.0...v0.5.0) (2026-11-22)


### Features

* **api:** the shapes of attachments, uploads and storage ([ebd9e35](https://github.com/WayfarerLabs/agention/commit/ebd9e35459a9e816d671b66e9f7560fa316e43ed))
* **bridge:** stream file bodies through the agent API ([4b05e79](https://github.com/WayfarerLabs/agention/commit/4b05e7923cbbfe439adfed04d3052352f9afc136))
* **bridge:** upload and fetch files, and attach them to messages ([e8f7477](https://github.com/WayfarerLabs/agention/commit/e8f74776ea511a9612495b265467e0cbd60145bb))
* **plugin:** teach files, and give Codex time for transfers ([4d93e1d](https://github.com/WayfarerLabs/agention/commit/4d93e1d64c38cd7700d5cda8dfb3093fadd0ebba))
* remove a pending upload before it is sent ([ecd7ec5](https://github.com/WayfarerLabs/agention/commit/ecd7ec54d44c0af6162b680228bd115049a6008d))
* **server:** API keys and the operator API at /api/operator/v1 ([f33776a](https://github.com/WayfarerLabs/agention/commit/f33776aea08117e3375c17daa59ab7e41c76e042))
* **server:** describe the API's shared schemas once in its OpenAPI document ([ed8b618](https://github.com/WayfarerLabs/agention/commit/ed8b618997d5fd7e4e4e732252c478f93fed99ee))
* **server:** lead /docs/api to the documentation page with --api-docs ([8b8fd64](https://github.com/WayfarerLabs/agention/commit/8b8fd640aec7c4741065f4fac4347c63a53f8eac))
* **server:** serve the API's documentation with agention serve --api-docs ([6ff3fab](https://github.com/WayfarerLabs/agention/commit/6ff3fab2e9b016768f83800c3d0451e7cace7378))
* **server:** the listener's own deadlines on request bodies ([39e3596](https://github.com/WayfarerLabs/agention/commit/39e3596fe74584ba80c6449f2010ff23425a955b))
* **server:** the operator's wait across sessions at GET /wait ([f06d9f6](https://github.com/WayfarerLabs/agention/commit/f06d9f675d58439789f2c0e4d8bd0a78e5f74d88))
* **server:** the tables of files, their chunks and attachments ([26d0683](https://github.com/WayfarerLabs/agention/commit/26d068305dab1c3d47788cb331f8eaef0e32b6b3))
* **server:** upload and read files on both mounts, served inert ([914f384](https://github.com/WayfarerLabs/agention/commit/914f3845d5a0d545feffcb0a6de5291feb8e51a5))
* **server:** uploads and the files messages carry, in the store ([27a7bba](https://github.com/WayfarerLabs/agention/commit/27a7bbaef525364df03bdc90c2433a9132b6d0cd))
* **web:** attach files in the composer, and paste images into it ([7143099](https://github.com/WayfarerLabs/agention/commit/714309984432705db04d5fcfaada6c493340ac6a))
* **web:** count unread threads and registrations waiting on the tabs ([a5414a9](https://github.com/WayfarerLabs/agention/commit/a5414a981a5f493e3f02c1f11e101c0736f3eb9f))
* **web:** flag an API key that never expires ([39197f0](https://github.com/WayfarerLabs/agention/commit/39197f0ef36fcb3e2bc45f3935eb2b9eee846c41))
* **web:** Settings in sections, each at its own address ([cc4ff7e](https://github.com/WayfarerLabs/agention/commit/cc4ff7e957a410cf977d6fb9f8d41efd88266942))
* **web:** show a message's files in place, the thread's in its head, and storage ([0a673d5](https://github.com/WayfarerLabs/agention/commit/0a673d54596f6a820b3b54a4f8980830ea4f2b86))
* **web:** the API keys section in Settings ([04969d4](https://github.com/WayfarerLabs/agention/commit/04969d45d81110e4b85c9de22b6e8d1461afc740))


### Bug Fixes

* **bridge:** give an upload's answer time for what links still hold ([cb3965d](https://github.com/WayfarerLabs/agention/commit/cb3965dec19837304dba4b2026ae955461621de4))
* **bridge:** name a fetched file only by a reference, and refuse an oversized one ([3ecbaf8](https://github.com/WayfarerLabs/agention/commit/3ecbaf834033c2d48fa81e7c8b7c086cfbd45876))
* **bridge:** open an upload without taking a terminal, and spell the key directory once ([0d4ab3f](https://github.com/WayfarerLabs/agention/commit/0d4ab3f31d1bea92f04488c25be945839685a694))
* **bridge:** remove a fetch's partial file when it cannot be put in place ([263d025](https://github.com/WayfarerLabs/agention/commit/263d025423822053a2d17126a3595566d38e12b9))
* **plugin:** a file's contents are material to work with, not the operator's words ([5d61788](https://github.com/WayfarerLabs/agention/commit/5d6178897d3a780156b630c3a87f83880f7a36d8))
* **server:** answer a file read whose first chunk fails as the app does ([3f1e60d](https://github.com/WayfarerLabs/agention/commit/3f1e60d5e1c11c8d11a9f0d6d97793ebdb845682))
* **server:** check the recent sign-in before looking up a key to revoke ([3e1e9b4](https://github.com/WayfarerLabs/agention/commit/3e1e9b4cf18cdb4fdc7f3abfd6f50e442430fdae))
* **server:** confirm every operation's scope in the store, not only at the mount ([f8e04f3](https://github.com/WayfarerLabs/agention/commit/f8e04f34775472e1bff43585cad270efa0c9b8b0))
* **server:** decide uploads from the path Hono routes, in the listener too ([6842829](https://github.com/WayfarerLabs/agention/commit/6842829cbb0105a087407a24bec9feb87b5fb653))
* **server:** describe an upload's body as any type, and say HEAD reads a file ([24ed6dd](https://github.com/WayfarerLabs/agention/commit/24ed6dd8ee9d554938187cdca24b8fe79d961d5b))
* **server:** end a browser session's operator wait when the session ends ([74fca56](https://github.com/WayfarerLabs/agention/commit/74fca56c0a739a0015979588303bdd6f153d6f39))
* **server:** hold rate buckets only for keys that spent recently ([544e5be](https://github.com/WayfarerLabs/agention/commit/544e5be00bf41b39cac55f7d61327aeffa5e6c34))
* **server:** keep a request's deadlines until its body is complete ([63162e8](https://github.com/WayfarerLabs/agention/commit/63162e8828209c795bdc38f9a1dc4ed27016aa74))
* **server:** keep revoked and expired keys listed while a key's use is recorded ([efbbd7e](https://github.com/WayfarerLabs/agention/commit/efbbd7e1b9a7a2c5a8a94c84900b832271a87778))
* **server:** leave a key that already expired as expired when a passkey link revokes keys ([41a1d64](https://github.com/WayfarerLabs/agention/commit/41a1d640a29cf0275706aeaccae3e5b65579fc21))
* **server:** log the one-time vacuum switch, under the server's prefix ([fb7ff78](https://github.com/WayfarerLabs/agention/commit/fb7ff7858b2dc9103720dc7aa8613341d1f96256))
* **server:** prefix the app's default log, and keep the vacuum switch out of test output ([a2eae21](https://github.com/WayfarerLabs/agention/commit/a2eae21da965eea7eb2c146d5299ff74435038bc))
* **server:** revoke every API key when a passkey link replaces the passkeys ([481a257](https://github.com/WayfarerLabs/agention/commit/481a25769e4e3e5f695908f400c268107d6a8654))
* **server:** serve the API documentation's page under a policy of its own ([570332c](https://github.com/WayfarerLabs/agention/commit/570332cd4a11ee919342bc3946ecc4d5c310b2a4))
* **server:** take an upload on any version of the operator mount ([5e5e5a5](https://github.com/WayfarerLabs/agention/commit/5e5e5a5f02ae5e503fb2cd297ca7a48f387ce121))
* **server:** word the storage-full refusal for whoever reads it ([328c8b0](https://github.com/WayfarerLabs/agention/commit/328c8b096998d21d7fa128da52bc4ba802a3e4fa))
* **web:** files after review: empty text, bounded reads, names and paste ([efc8c0f](https://github.com/WayfarerLabs/agention/commit/efc8c0f27c63d1f85f0b25d23b7958a3b21f90c4))
* **web:** keep a hidden input hidden ([c482263](https://github.com/WayfarerLabs/agention/commit/c48226305e76c298481c1f6562c9480433adb828))
* **web:** let a removed upload whose bytes have all gone answer, then remove it ([0c9f48c](https://github.com/WayfarerLabs/agention/commit/0c9f48c6814f3d5449d1836e7e2e70232e3b06b0))
* **web:** move focus in the same commit as the change that needs it ([ec62071](https://github.com/WayfarerLabs/agention/commit/ec62071ad64582dc7ea90358a76aad07c6b02ebf))
* **web:** never start recording when the page was hidden while the microphone opened ([24ae73c](https://github.com/WayfarerLabs/agention/commit/24ae73ceb104afe2841ab4a2c8a62e19aecac812))
* **web:** show a saved transcription key masked in its field, ending in its last four ([b1898ce](https://github.com/WayfarerLabs/agention/commit/b1898ce9b1259f664dd44de61ef9bcec7478a288))

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
