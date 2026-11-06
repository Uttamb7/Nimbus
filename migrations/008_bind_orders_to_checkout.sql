ALTER TABLE orders
  ADD COLUMN sku text,
  ADD COLUMN quantity integer;

UPDATE orders
SET sku = inventory_reservations.sku,
    quantity = inventory_reservations.quantity
FROM inventory_reservations
WHERE orders.reservation_id = inventory_reservations.id;

ALTER TABLE orders
  ADD CONSTRAINT orders_sku_valid CHECK (sku IS NULL OR (length(btrim(sku)) > 0 AND length(sku) <= 64)),
  ADD CONSTRAINT orders_quantity_valid CHECK (quantity IS NULL OR quantity BETWEEN 1 AND 100);
