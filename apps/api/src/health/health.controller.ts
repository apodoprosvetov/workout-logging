import { Controller, Get, HttpCode, HttpStatus } from '@nestjs/common';

// Unauthenticated on purpose: Caddy's active health check (infra/Caddyfile,
// research.md #7) and the CloudWatch Synthetics canary (research.md #8,
// T032) both need to reach this without credentials. By the time Nest is
// listening, TypeOrmModule/MongooseModule have already connected (module
// init runs before app.listen()), so "reachable" already implies "DB
// connections are up" — no separate DB ping needed here.
@Controller('health')
export class HealthController {
  @Get()
  @HttpCode(HttpStatus.OK)
  check() {
    return { status: 'ok' };
  }
}
