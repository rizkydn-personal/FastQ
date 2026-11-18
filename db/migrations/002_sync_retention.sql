CREATE TABLE IF NOT EXISTS sync_devices (
  outlet_id uuid NOT NULL REFERENCES outlets(id),
  device_id uuid NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  last_cursor bigint NOT NULL DEFAULT 0 CHECK (last_cursor >= 0),
  PRIMARY KEY (outlet_id, device_id)
);

CREATE INDEX IF NOT EXISTS sync_devices_recent_outlet
  ON sync_devices(outlet_id, last_seen_at DESC, last_cursor);

CREATE INDEX IF NOT EXISTS sync_events_received_retention
  ON sync_events(received_at, outlet_id, server_cursor);

CREATE INDEX IF NOT EXISTS sync_events_product_price_history
  ON sync_events(outlet_id, (payload->>'id'), occurred_at DESC, server_cursor DESC)
  WHERE event_type='product.upsert';

CREATE TABLE IF NOT EXISTS sync_event_retention (
  outlet_id uuid PRIMARY KEY REFERENCES outlets(id),
  minimum_cursor bigint NOT NULL DEFAULT 0 CHECK (minimum_cursor >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
