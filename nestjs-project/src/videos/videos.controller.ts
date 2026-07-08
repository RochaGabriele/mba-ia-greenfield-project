import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { ListVideosQueryDto } from './dto/list-videos-query.dto';
import {
  PaginatedVideosDto,
  VideoResponseDto,
} from './dto/video-response.dto';
import { PresignPartsDto } from './dto/presign-parts.dto';
import {
  CreateDraftResult,
  StreamResult,
  UploadStatusView,
  VideosService,
} from './videos.service';

@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post()
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Create a video draft and initiate the upload',
    description:
      'Pre-registers the video as a draft under the caller channel, generates the unique ' +
      'public id and storage key, and initiates a multipart upload. Returns the data the ' +
      'client needs to upload parts directly to object storage.',
  })
  @ApiResponse({
    status: 201,
    description: 'Draft created and multipart upload initiated',
    schema: {
      properties: {
        publicId: { type: 'string' },
        uploadId: { type: 'string' },
        storageKey: { type: 'string' },
        partSize: { type: 'integer' },
        status: { type: 'string', example: 'draft' },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 413,
    description: 'Upload exceeds the maximum allowed size',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async create(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateVideoDto,
  ): Promise<CreateDraftResult> {
    return this.videosService.createDraft(user.sub, dto);
  }

  @Post(':publicId/upload/part-urls')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get presigned URLs to upload parts',
    description:
      'Returns a presigned PUT URL per requested part number so the client uploads each part ' +
      'directly to object storage. Owner-only; the first call moves the video to "uploading".',
  })
  @ApiResponse({
    status: 201,
    description: 'Presigned part URLs',
    schema: {
      type: 'array',
      items: {
        properties: {
          partNumber: { type: 'integer' },
          url: { type: 'string' },
        },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'The caller does not own this video',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Upload cannot be continued in the current state',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async presignParts(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
    @Body() dto: PresignPartsDto,
  ): Promise<Array<{ partNumber: number; url: string }>> {
    return this.videosService.presignParts(user.sub, publicId, dto.partNumbers);
  }

  @Post(':publicId/upload/complete')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Complete the upload and start processing',
    description:
      'Finalizes the multipart upload with the client-provided part ETags, moves the video to ' +
      '"processing", and enqueues the background processing job. Owner-only.',
  })
  @ApiResponse({
    status: 200,
    description: 'Upload completed; processing enqueued',
    schema: {
      properties: {
        publicId: { type: 'string' },
        status: { type: 'string', example: 'processing' },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'The caller does not own this video',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Upload cannot be completed in the current state',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
    @Body() dto: CompleteUploadDto,
  ): Promise<UploadStatusView> {
    return this.videosService.completeUpload(user.sub, publicId, dto.parts);
  }

  @Post(':publicId/upload/abort')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Abort an in-progress upload',
    description:
      'Aborts the multipart upload and removes the draft video. Owner-only.',
  })
  @ApiResponse({ status: 204, description: 'Upload aborted; draft removed' })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'The caller does not own this video',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Upload cannot be aborted in the current state',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async abortUpload(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
  ): Promise<void> {
    return this.videosService.abortUpload(user.sub, publicId);
  }

  @Get()
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: "List the caller's channel videos",
    description:
      "Lists the authenticated caller's own videos (any status), newest first, paginated.",
  })
  @ApiResponse({
    status: 200,
    description: "Paginated list of the caller's videos",
    type: PaginatedVideosDto,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async list(
    @CurrentUser() user: JwtPayload,
    @Query() query: ListVideosQueryDto,
  ): Promise<PaginatedVideosDto> {
    return this.videosService.listOwn(user.sub, query.page, query.pageSize);
  }

  @Public()
  @UseGuards(OptionalJwtAuthGuard)
  @Get(':publicId')
  @ApiOperation({
    summary: 'Get a single video',
    description:
      'Public for `ready` videos; drafts/processing/error videos are only visible to their owner.',
  })
  @ApiResponse({
    status: 200,
    description: 'Video view',
    type: VideoResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getOne(
    @CurrentUser() user: JwtPayload | undefined,
    @Param('publicId') publicId: string,
  ): Promise<VideoResponseDto> {
    return this.videosService.getByPublicId(publicId, user?.sub ?? null);
  }

  @Public()
  @SkipThrottle()
  @Get(':publicId/stream')
  @ApiOperation({
    summary: 'Stream a video (HTTP Range)',
    description:
      'Streams a `ready` video. A Range header yields 206 Partial Content (Content-Range/' +
      'Accept-Ranges); without it, 200 with Accept-Ranges. Playback starts without a full download.',
  })
  @ApiResponse({ status: 200, description: 'Full stream (no Range)' })
  @ApiResponse({ status: 206, description: 'Partial stream (Range)' })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready for playback',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 416,
    description: 'Requested range not satisfiable',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async stream(
    @Param('publicId') publicId: string,
    @Headers('range') rangeHeader: string | undefined,
    @Res({ passthrough: false }) res: Response,
  ): Promise<void> {
    this.pipeStream(
      res,
      await this.videosService.getStreamData(publicId, rangeHeader),
    );
  }

  @Public()
  @SkipThrottle()
  @Get(':publicId/download')
  @ApiOperation({
    summary: 'Download a video',
    description: 'Downloads a `ready` video as an attachment.',
  })
  @ApiResponse({ status: 200, description: 'The video file as an attachment' })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready for playback',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async download(
    @Param('publicId') publicId: string,
    @Res({ passthrough: false }) res: Response,
  ): Promise<void> {
    this.pipeStream(res, await this.videosService.getDownloadData(publicId));
  }

  @Public()
  @SkipThrottle()
  @Get(':publicId/thumbnail')
  @ApiOperation({
    summary: 'Get a video thumbnail',
    description: 'Returns the generated JPEG thumbnail.',
  })
  @ApiResponse({ status: 200, description: 'JPEG thumbnail' })
  @ApiResponse({
    status: 404,
    description: 'Video or thumbnail not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async thumbnail(
    @Param('publicId') publicId: string,
    @Res({ passthrough: false }) res: Response,
  ): Promise<void> {
    this.pipeStream(res, await this.videosService.getThumbnailData(publicId));
  }

  private pipeStream(res: Response, result: StreamResult): void {
    res.status(result.status);
    for (const [key, value] of Object.entries(result.headers)) {
      res.setHeader(key, value);
    }
    result.stream.on('error', () => {
      if (!res.headersSent) {
        res.status(500).end();
      } else {
        res.destroy();
      }
    });
    result.stream.pipe(res);
  }
}
