# Changelog

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
