# Security Specifications & Threat Vector Analysis

This document outlines the zero-trust data invariants, "Dirty Dozen" attack payloads, and security-rule requirements for the clinical IVF inventory system.

## 1. Zero-Trust Data Invariants

1.  **Product Profiles**:
    *   `sku` must be alphanumeric, capitalized, and have a maximum size of 64 characters to prevent ID-poisoning or character injection attacks.
    *   `name` must be a string of size `[2, 256]`.
    *   `brand` must be a string of size `[2, 128]` if defined.
    *   `safetyStock` must be an integer, greater than or equal to 0, and under 10,000.
    *   `unitsPerBox` must be an integer between 1 and 1000.
2.  **Inventory Batches**:
    *   `id` must match alphanumeric format.
    *   `sku` MUST correspond to a valid ProductProfile.
    *   `lot` must be alphanumeric, non-empty, and limited to 64 characters.
    *   `quantity` must be a non-negative integer under 1,000,000.
    *   `createdAt` must match string shape or server timestamp.
    *   `sstRequired` must be a boolean value.
    *   `sstPassed` must be a boolean value.
3.  **Movement Logs**:
    *   `id` must match alphanumeric format.
    *   `type` must be strictly restricted to `["STOCK_IN", "STOCK_OUT", "STOCK_OUT_OVERRIDE", "WASTE"]`.
    *   `quantity` must be an integer greater than 0.
    *   `sku`, `name`, and `lot` must match constraints of standard items.

---

## 2. The "Dirty Dozen" Attack Payloads

These 12 malicious JSON payloads represent attempts by bad actors or misconfigured SDKs to bypass safety policies. All of these must be rejected with `PERMISSION_DENIED`:

### Threat V1: Admin Right Escalation (Identity Injection)
Try to inject custom admin properties into a Product Profile:
```json
{
  "sku": "PHP-TEST",
  "name": "Bypassed pH Paper",
  "brand": "Vitrolife",
  "safetyStock": 5,
  "sstRequired": false,
  "isAdmin": true,
  "role": "OWNER"
}
```

### Threat V2: Denial of Wallet (Rejection Limit Exhaustion)
Try to inject massive multi-megabyte string into the Brand field:
```json
{
  "sku": "PHP-DOW",
  "name": "DOW Pipette",
  "brand": "Vitrolife_extremely_long_junk_string_consisting_of_hundreds_of_thousands_of_characters_to_overload_cache_and_inflate_egress_bills...",
  "safetyStock": 2,
  "sstRequired": false
}
```

### Threat V3: Negative Quantities (Inventory Depletion)
Receive a negative batch size to deplete stock reporting:
```json
{
  "id": "sci-test-neg-1",
  "sku": "PHP-38014",
  "name": "pH Paper",
  "lot": "MALICIOUS",
  "expiryDate": "2029-01-01",
  "quantity": -500,
  "createdAt": "2026-06-01T00:00:00.000Z"
}
```

### Threat V4: Unauthorized Batch Updates (Ghost Modifications)
Attempt to edit the `sku` or `lot` of an existing active batch:
```json
{
  "id": "existing-sci-batch-1",
  "sku": "INJECTED-SKU",
  "name": "Altered Name",
  "lot": "CHANGED-LOT",
  "quantity": 5
}
```

### Threat V5: Illegal String Expiry format (Temporal Corruption)
Passing non-standard junk strings inside the batch expiration date:
```json
{
  "id": "sci-batch-expiry-poison",
  "sku": "PHP-38014",
  "name": "pH Paper",
  "lot": "38014",
  "expiryDate": "NEVER-EXPIRES-TRAP-AND-CRASH-LINT-OR-PARSER",
  "quantity": 10,
  "createdAt": "2026-06-01T00:00:00.000Z"
}
```

### Threat V6: Negative Log Entry
Attempting to create a movement log entry with zero or negative quantity:
```json
{
  "id": "log-attack-1",
  "timestamp": "2026-06-01T00:00:00.000Z",
  "type": "STOCK_IN",
  "sku": "PHP-38014",
  "name": "pH Paper",
  "lot": "38014",
  "expiryDate": "2028-02-29",
  "quantity": -20
}
```

### Threat V7: Invalid Enum Actions (State Hijack)
Specifying an uncertified event action on a movement log:
```json
{
  "id": "log-attack-2",
  "timestamp": "2026-06-01T00:00:00.000Z",
  "type": "FORCE_DELETE_ENTIRE_DATABASE",
  "sku": "PHP-38014",
  "name": "pH Paper",
  "lot": "38014",
  "expiryDate": "2028-02-29",
  "quantity": 10
}
```

### Threat V8: Anonymous Write without Verified Multi-Factor Authentication
Attempt to register a document without a verified email (email_verified: false):
```json
{
  "sku": "UNPRIVILEGED-WRITE",
  "name": "Hacked Pipette",
  "safetyStock": 1,
  "sstRequired": false
}
```

### Threat V9: Invalid ID format (Path Variable Poisoning)
Document creation at path variable containing malicious terminal escapes:
`/batches/some-id-%0D%0A-poisoned-newline-character`

### Threat V10: Immature / Retroactive Creation Timestamps (Timestamp Manipulation)
Hacking the batch creation time to a historic date in 1970 to bypass expirations:
```json
{
  "id": "time-hack",
  "sku": "PHP-38014",
  "name": "pH Paper",
  "lot": "38014",
  "expiryDate": "2028-02-29",
  "quantity": 5,
  "createdAt": "1970-01-01T00:00:00.000Z"
}
```

### Threat V11: Orphaned Batch Registration
Registering an active batch with a SKU that has absolutely no associated ProductProfile registered:
```json
{
  "id": "orphaned-batch",
  "sku": "NONEXISTENT-SKU",
  "name": "Phantom Pipette",
  "lot": "PH-001",
  "expiryDate": "2030-01-01",
  "quantity": 10,
  "createdAt": "2026-06-01T00:00:00.000Z"
}
```

### Threat V12: Value Poisoning (Standard Pack Size Override)
Attempting to force an illegal float or negative standard pack size:
```json
{
  "sku": "FLOAT-PACK-SIZE",
  "name": "Improper Packing Pipette",
  "safetyStock": 5,
  "sstRequired": false,
  "unitsPerBox": -23.5
}
```

---

## 3. Test Runner Design

While there is no offline local firestore emulator explicitly requested, we enforce these checks in our production Firestore Rule matching systems.
