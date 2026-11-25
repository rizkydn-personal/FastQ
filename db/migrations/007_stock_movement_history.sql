CREATE INDEX IF NOT EXISTS stock_movements_outlet_time_id
  ON stock_movements(outlet_id, occurred_at DESC, id DESC);
