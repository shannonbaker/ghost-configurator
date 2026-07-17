# GHOST MSPv2 Configuration Protocol v1.0

This protocol configures canonical GHOST field subscriptions over a reliable,
bidirectional MSP connection. Runtime field values continue to use the MSP
DisplayPort `WRITE_STRING` tunnel.

The provisional private range is `0x4F00` through `0x4FFF`. Multi-byte values
are little-endian and slots are zero-based. Every response starts with a status
byte: `OK=0`, `BAD_LENGTH=1`, `ARMED=2`, `INVALID_TRANSACTION=3`,
`INVALID_SLOT=4`, `UNSUPPORTED_FIELD=5`, `INVALID_RATE=6`,
`STALE_REVISION=7`, `INVALID_CONFIG=8`, `PROFILE_TOO_LARGE=9`,
`INVALID_OFFSET=10`, and `CRC_MISMATCH=11`.

| Command | ID | Request | Success response after status |
| --- | ---: | --- | --- |
| Capabilities | `0x4F00` | empty | major `u8`, minor `u8`, flags `u16`, slots `u8`, max Hz `u8`, revision `u16` |
| Field catalog | `0x4F01` | start ID `u8`, max records `u8` | total `u8`, next ID `u8`, count `u8`, descriptors |
| Subscriptions | `0x4F02` | start slot `u8`, max records `u8` | revision `u16`, total `u8`, next slot `u8`, count `u8`, records |
| Begin | `0x4F03` | expected revision `u16` | transaction ID `u8`, revision `u16` |
| Set | `0x4F04` | transaction `u8`, slot `u8`, field `u8`, rate Hz `u8` | none |
| Clear | `0x4F05` | transaction `u8`, slot `u8` | none |
| Validate | `0x4F06` | transaction `u8` | none |
| Commit | `0x4F07` | transaction `u8`, flags `u8` | new revision `u16` |
| Abort | `0x4F08` | transaction `u8` | none |
| Profile info | `0x4F10` | empty | format, limit, revision, length, CRC32 |
| Profile read | `0x4F11` | offset `u16`, max `u8` | metadata, offset, length, bytes |
| Profile begin | `0x4F12` | expected/new revisions, length, CRC32 | transaction ID, current revision |
| Profile chunk | `0x4F13` | transaction `u8`, offset `u16`, bytes | next offset `u16` |
| Profile commit | `0x4F14` | transaction `u8`, flags `u8` | revision, length, CRC32 |
| Profile abort | `0x4F15` | transaction `u8` | none |

A field descriptor is `field_id u8`, `type u8`, `unit u8`, `max_rate_hz u8`,
`name_length u8`, followed by the UTF-8 name. Types are `U8=1`, `I16=2`,
`U16=3`, and `I32=4`. Units are `NONE=0`, `DECIDEGREES=1`, `DEGREES_E7=2`,
`CENTIMETRES=3`, `CENTIMETRES_PER_SECOND=4`, `MILLIVOLTS=5`, `CENTIAMPS=6`,
`MILLIAMP_HOURS=7`, `MICROSECONDS=8`, and `COUNT=9`.

A subscription record is `slot u8`, `field_id u8`, `rate_hz u8`.
`next_slot=255` and `next_field_id=0` mark the final page. Clear slot 255 clears
the full staged table. Commit flag bit zero requests persistence.

Mutation commands are rejected while armed. Clients must reject unsupported
major versions, ignore unknown capability bits, begin from the latest revision,
validate before committing, and read back the committed table.
