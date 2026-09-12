import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { configureApi } from "./bootstrap";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  configureApi(app);
  await app.listen(process.env.PORT ?? 3001);
}
void bootstrap();
