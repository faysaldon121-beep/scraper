import mongoose, { Schema, Document, Model } from "mongoose";

export interface IRequirements {
  os: string;
  cpu: string;
  ram: string;
  gpu: string;
  storage: string;
  directx?: string;
}

export interface IDownloadLink {
  label: string;
  url: string;
  size?: string;
  host?: string;
}

export interface IGame extends Document {
  title: string;
  slug: string;
  description: string;
  shortDescription: string;
  coverImage: string;
  images: string[];
  genre: string;
  platforms: string[];
  version: string;
  developer: string;
  publisher: string;
  releaseDate: Date;
  requirements: {
    minimum: IRequirements;
    recommended: IRequirements;
  };
  installationGuide: string[];
  downloadLinks: IDownloadLink[];
  fileSize: string;
  isFeatured: boolean;
  averageRating: number;
  reviewCount: number;
  downloadCount: number;
  tags: string[];
  changelog: string;
  createdAt: Date;
  updatedAt: Date;
}

const RequirementsSchema = new Schema<IRequirements>({
  os: { type: String, default: "" },
  cpu: { type: String, default: "" },
  ram: { type: String, default: "" },
  gpu: { type: String, default: "" },
  storage: { type: String, default: "" },
  directx: { type: String, default: "" },
}, { _id: false });

const DownloadLinkSchema = new Schema<IDownloadLink>({
  label: { type: String, required: true },
  url: { type: String, required: true },
  size: { type: String, default: "" },
  host: { type: String, default: "Direct" },
}, { _id: false });

const GameSchema = new Schema<IGame>({
  title: { type: String, required: true, trim: true },
  slug: { type: String, required: true, unique: true, lowercase: true },
  description: { type: String, required: true },
  shortDescription: { type: String, default: "" },
  coverImage: { type: String, default: "https://placehold.co/800x450/0f0f1a/7c3aed?text=No+Image" },
  images: [{ type: String }],
  genre: { type: String, required: true },
  platforms: [{ type: String }],
  version: { type: String, default: "1.0" },
  developer: { type: String, default: "Unknown" },
  publisher: { type: String, default: "Unknown" },
  releaseDate: { type: Date, default: Date.now },
  requirements: {
    minimum: { type: RequirementsSchema, default: () => ({}) },
    recommended: { type: RequirementsSchema, default: () => ({}) },
  },
  installationGuide: [{ type: String }],
  downloadLinks: [DownloadLinkSchema],
  fileSize: { type: String, default: "" },
  isFeatured: { type: Boolean, default: false },
  averageRating: { type: Number, default: 0, min: 0, max: 5 },
  reviewCount: { type: Number, default: 0 },
  downloadCount: { type: Number, default: 0 },
  tags: [{ type: String }],
  changelog: { type: String, default: "" },
}, { timestamps: true });

GameSchema.index({ title: "text", description: "text", tags: "text" });
GameSchema.index({ slug: 1 });
GameSchema.index({ genre: 1 });
GameSchema.index({ isFeatured: -1, averageRating: -1 });

const Game: Model<IGame> = mongoose.models.Game ?? mongoose.model<IGame>("Game", GameSchema);

export default Game;
