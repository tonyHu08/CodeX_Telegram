# Relay API (Hosted Mode)

## Device registration

### `POST /v1/devices/register`

Request:

```json
{
  "deviceFingerprint": "macos-14-arm64",
  "appVersion": "0.1.0",
  "platform": "macos"
}
```

Response:

```json
{
  "deviceId": "uuid",
  "deviceToken": "token",
  "createdAt": 1739490000000
}
```

## Pairing

- `POST /v1/pairing/sessions`
- `GET /v1/pairing/sessions/{id}`
- `POST /v1/pairing/sessions/{id}/confirm`

## Device stream

### `WS /v1/devices/stream?token=...`

Inbound events:
- `incomingUserMessage`
- `incomingControlCommand`
- `approvalDecision`

Outbound events:
- `executionStatus`
- `finalResponse`
- `approvalRequest`

## Anonymous analytics

### `POST /v1/analytics/events`

Payload fields:
- `eventId`
- `name`
- `timestamp`
- `appVersion`
- `locale`
- `channelTag`
- `deviceIdHash`
- `payload` (optional object)

### `GET /v1/analytics/summary`

Returns aggregate counters only.
