import { INestApplication, ValidationPipe } from "@nestjs/common";

function allowedOrigins(): string[] {
  return (process.env.FRONTEND_ORIGIN ?? "http://localhost:5173")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export function configureApi(app: INestApplication): void {
  const httpAdapter = app.getHttpAdapter();
  const rawApp = httpAdapter.getInstance();
  if (rawApp && typeof rawApp.set === "function") {
    const rawHops = process.env.TRUST_PROXY_HOPS ?? process.env.TRUST_PROXY ?? "1";
    if (rawHops === "false" || rawHops === "0") {
      rawApp.set("trust proxy", false);
    } else {
      const hopsNumber = parseInt(rawHops, 10);
      rawApp.set("trust proxy", Number.isNaN(hopsNumber) ? rawHops : hopsNumber);
    }
  }

  const origins = allowedOrigins();
  app.enableCors({
    origin(origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void) {
      if (!origin || origins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error("Origin is not permitted"));
    },
    methods: ["GET", "POST", "PATCH", "PUT", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type"],
  });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
}
