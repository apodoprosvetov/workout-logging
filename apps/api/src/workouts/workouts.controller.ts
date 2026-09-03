import { Controller, Get, Body, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, Req, UseGuards, Delete } from '@nestjs/common';
import { WorkoutSource } from '@workout-logging/shared';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CreateWorkoutDto } from './dto/create-workout.dto';
import { ListWorkoutsQueryDto } from './dto/list-workouts-query.dto';
import { IngestRateLimitGuard } from './ingest-rate-limit.guard';
import { IngestionService } from './ingestion.service';
import { WorkoutsService } from './workouts.service';

@Controller('workouts')
@UseGuards(JwtAuthGuard)
export class WorkoutsController {
  constructor(
    private readonly ingestionService: IngestionService,
    private readonly workoutsService: WorkoutsService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(IngestRateLimitGuard)
  async create(@Req() req: AuthenticatedRequest, @Body() dto: CreateWorkoutDto) {
    const result = await this.ingestionService.ingest({
      userId: req.userId,
      text: dto.text,
      imageBuffers: dto.images,
      performedAt: dto.performed_at ? new Date(dto.performed_at) : undefined,
      source: WorkoutSource.WEB,
    });

    return { workout_id: result.workoutId, status: result.status };
  }

  @Get()
  async list(@Req() req: AuthenticatedRequest, @Query() query: ListWorkoutsQueryDto) {
    return this.workoutsService.list(req.userId, query);
  }

  @Get(':id')
  async getById(@Req() req: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.workoutsService.getById(req.userId, id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteById(@Req() req: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string) {
    await this.workoutsService.deleteById(req.userId, id);
  }
}
