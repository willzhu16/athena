# Changelog

## [1.9.0](https://github.com/willzhu16/athena/compare/v1.8.0...v1.9.0) (2026-09-24)


### Features

* **acceptance:** check every packet, not the one someone named ([#34](https://github.com/willzhu16/athena/issues/34)) ([5599cd8](https://github.com/willzhu16/athena/commit/5599cd88d31a8171c3727c55fc86a5e20d0e9502))
* **harness:** ratchet the coverage floors too ([#31](https://github.com/willzhu16/athena/issues/31)) ([20907ec](https://github.com/willzhu16/athena/commit/20907ecc5384dbface7c4230a2746df6abe786d8))


### Bug Fixes

* **harness:** close three ways the ratchet held nothing ([#35](https://github.com/willzhu16/athena/issues/35)) ([4e4c16a](https://github.com/willzhu16/athena/commit/4e4c16a62a8f4d7edb3007eaea3b0e552692247e))
* **harness:** report unreadable files instead of crashing on them ([#30](https://github.com/willzhu16/athena/issues/30)) ([b24b332](https://github.com/willzhu16/athena/commit/b24b33283063e876e9c001705f41ae49b0f824d7))
* **instructions:** give each anti-loop rule exactly one home ([#32](https://github.com/willzhu16/athena/issues/32)) ([3009acd](https://github.com/willzhu16/athena/commit/3009acd770cb9266f15defc6fdc36beeec476d48))

## [1.8.0](https://github.com/willzhu16/athena/compare/v1.7.0...v1.8.0) (2026-09-23)


### Features

* **harness:** make the quality numbers move one way ([#27](https://github.com/willzhu16/athena/issues/27)) ([53b71a8](https://github.com/willzhu16/athena/commit/53b71a86d3093e60097360081edce58e7554b62c))
* **skills:** ship the review protocol and packet format on demand ([#28](https://github.com/willzhu16/athena/issues/28)) ([020a0a7](https://github.com/willzhu16/athena/commit/020a0a706f931afa6459a8bce55102d3a159c4f7))

## [1.7.0](https://github.com/willzhu16/athena/compare/v1.6.1...v1.7.0) (2026-09-21)


### Features

* **skills:** ship procedure that costs nothing until it is needed ([#25](https://github.com/willzhu16/athena/issues/25)) ([2f01fc9](https://github.com/willzhu16/athena/commit/2f01fc99246ddebfb4fc8517319ceb5013229c4d))

## [1.6.1](https://github.com/willzhu16/athena/compare/v1.6.0...v1.6.1) (2026-09-21)


### Bug Fixes

* **instructions:** stop claiming rules the linters now enforce ([#23](https://github.com/willzhu16/athena/issues/23)) ([1d288b1](https://github.com/willzhu16/athena/commit/1d288b19b6b8660e20855ac86d91ef451f819476))

## [1.6.0](https://github.com/willzhu16/athena/compare/v1.5.0...v1.6.0) (2026-09-19)


### Features

* **hooks:** make a green gate the condition for ending a turn ([#21](https://github.com/willzhu16/athena/issues/21)) ([2f07f4f](https://github.com/willzhu16/athena/commit/2f07f4f0aff499d19756fe3a90e259f40943cfcb))

## [1.5.0](https://github.com/willzhu16/athena/compare/v1.4.0...v1.5.0) (2026-09-16)


### Features

* **acceptance:** read pytest reports so the gate works on Python repos ([#19](https://github.com/willzhu16/athena/issues/19)) ([3ff7da2](https://github.com/willzhu16/athena/commit/3ff7da2563781c25114b6ea0d3ba0ef424e7e346))

## [1.4.0](https://github.com/willzhu16/athena/compare/v1.3.1...v1.4.0) (2026-09-14)


### Features

* **permissions:** add tier selection and Codex command rules ([#16](https://github.com/willzhu16/athena/issues/16)) ([67c872c](https://github.com/willzhu16/athena/commit/67c872c09c05c461e3292d62119e1e2c8af04c6c))

## [1.3.1](https://github.com/willzhu16/athena/compare/v1.3.0...v1.3.1) (2026-09-12)


### Bug Fixes

* validate configs and correct permission coherence checks ([#13](https://github.com/willzhu16/athena/issues/13)) ([e4d225d](https://github.com/willzhu16/athena/commit/e4d225dae593cb94b6348d19c9691f5dc06d861a))

## [1.3.0](https://github.com/willzhu16/athena/compare/v1.2.0...v1.3.0) (2026-09-11)


### Features

* **release:** let the release PR run its own checks via AUTOMATION_TOKEN ([#11](https://github.com/willzhu16/athena/issues/11)) ([5b2203c](https://github.com/willzhu16/athena/commit/5b2203cf34fcd1e2b578e331247f0148f0cc7dd0))

## [1.2.0](https://github.com/willzhu16/athena/compare/v1.1.1...v1.2.0) (2026-09-11)


### Features

* **harness:** add harness-lint for rule and profile coherence ([#7](https://github.com/willzhu16/athena/issues/7)) ([79b5ac1](https://github.com/willzhu16/athena/commit/79b5ac1c741aaa0fcd6880051c0b5f3a020659ff))
* **instructions:** explain the harness to agents and ship /conductor ([#8](https://github.com/willzhu16/athena/issues/8)) ([c2a3bd2](https://github.com/willzhu16/athena/commit/c2a3bd25828d300bbff56ac158956dd8395c8f35))


### Bug Fixes

* **deps:** bump devDependencies to clear 6 osv advisories ([#9](https://github.com/willzhu16/athena/issues/9)) ([8f85de2](https://github.com/willzhu16/athena/commit/8f85de2fc42291ebf9789537b4ad0b363df1a8ec))

## [1.1.1](https://github.com/willzhu16/athena/compare/v1.1.0...v1.1.1) (2026-07-11)


### Bug Fixes

* **compile:** reject unknown tools in config.tools ([c8a465c](https://github.com/willzhu16/athena/commit/c8a465cc1c39ec13d85fb9d88ab0c8e61eadac1f))
* **doctor:** match compile's tool validation and never crash ([3787aea](https://github.com/willzhu16/athena/commit/3787aeadab9b8327b1d643feb9af8f6ddc6515d7))
* **doctor:** match compile's tool validation and never crash ([3104c2a](https://github.com/willzhu16/athena/commit/3104c2a8a4b3c99a6defeca224d48f68a1dfac2f))
* **release:** dispatch the v1 tag mover explicitly ([275f733](https://github.com/willzhu16/athena/commit/275f733186a08e1231ddb28e631991842690aa52))
* **release:** dispatch the v1 tag mover explicitly ([9d6a36a](https://github.com/willzhu16/athena/commit/9d6a36a5c536fcb000d1b8c162aba6584408bed9))

## [1.1.0](https://github.com/willzhu16/athena/compare/v1.0.0...v1.1.0) (2026-07-10)


### Features

* add athena AI harness (spec 04) ([ff6c396](https://github.com/willzhu16/athena/commit/ff6c3968ace1fdc074c0bc5a133c788a54094681))
* add release-please versioning and v1 major-tag mover ([7279872](https://github.com/willzhu16/athena/commit/7279872f6509a9551553e78e26e67eac244236e9))
* **doctor:** verify settings profile and harden config handling ([970064a](https://github.com/willzhu16/athena/commit/970064a911ae8fdf452acd5fd9ac798cf0dae4d4))
* **doctor:** verify settings.json matches t1 profile ([0d0baaf](https://github.com/willzhu16/athena/commit/0d0baaf347e45fde19b4764706d50ebf90819bac))


### Bug Fixes

* **doctor:** report malformed config as failed checks instead of crashing ([42440f6](https://github.com/willzhu16/athena/commit/42440f64e1087b9f81d70e4786f94bedabbb852c))
* **release:** keep plain vX.Y.Z tags via include-component-in-tag false ([0400609](https://github.com/willzhu16/athena/commit/040060937ab8e2ebb84ffcad66bbe1035c799f0b))
