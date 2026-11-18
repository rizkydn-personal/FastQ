DO $$
DECLARE
  runtime_role text;
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY['pos_app', 'pos_app_runtime'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = runtime_role) THEN
      EXECUTE format(
        'REVOKE INSERT, UPDATE, DELETE ON TABLE public.schema_migrations FROM %I',
        runtime_role
      );
    END IF;
  END LOOP;
END $$;
