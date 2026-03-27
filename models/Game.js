const mongoose = require("mongoose");
const { Schema } = mongoose;

const RequirementsSchema = new Schema(
  {
    os: { type: String, default: "" },
    cpu: { type: String, default: "" },
    ram: { type: String, default: "" },
    gpu: { type: String, default: "" },
    storage: { type: String, default: "" },
    directx: { type: String, default: "" },
  },
  { _id: false }
);

const DownloadLinkSchema = new Schema(
  {
    label: { type: String, required: true },
    url: { type: String, required: true },
    size: { type: String, default: "" },
    host: { type: String, default: "Direct" },
  },
  { _id: false }
);

const GameSchema = new Schema(
  {
    title: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, lowercase: true },
    description: { type: String, required: true },
    shortDescription: { type: String, default: "" },
    coverImage: {
      type: String,
      default: "https://placehold.co/800x450/0f0f1a/7c3aed?text=No+Image",
    },
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
  },
  { timestamps: true }
);

GameSchema.index({ title: "text", description: "text", tags: "text" });
GameSchema.index({ slug: 1 });
GameSchema.index({ genre: 1 });
GameSchema.index({ isFeatured: -1, averageRating: -1 });

const Game = mongoose.models.Game ?? mongoose.model("Game", GameSchema);

module.exports = Game;
