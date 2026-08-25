-- Quotes bind to this version. Any price/currency/availability change invalidates older snapshots.
CREATE FUNCTION bump_product_variant_version() RETURNS trigger AS $$
BEGIN
  IF OLD."priceMinor" IS DISTINCT FROM NEW."priceMinor"
     OR OLD.currency IS DISTINCT FROM NEW.currency
     OR OLD.active IS DISTINCT FROM NEW.active THEN
    NEW.version := OLD.version + 1;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ProductVariant_bump_version"
BEFORE UPDATE ON "ProductVariant"
FOR EACH ROW EXECUTE FUNCTION bump_product_variant_version();
