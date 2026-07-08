import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateVideoDto {
  /** Display title of the video. */
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title: string;

  /** Original file name; sanitized into the object storage key. */
  @IsString()
  @IsNotEmpty()
  filename: string;

  /**
   * Total upload size in bytes. Must be a positive integer here; the 10GB business
   * limit is enforced in the service so it returns 413 UPLOAD_TOO_LARGE (not a 400).
   */
  @IsInt()
  @Min(1)
  sizeBytes: number;

  /** Optional MIME type hint for the uploaded file. */
  @IsString()
  @IsOptional()
  contentType?: string;
}
