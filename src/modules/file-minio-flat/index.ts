import { Module } from "@medusajs/framework/utils"
import FileMinioFlatService from "./service"

export const FILE_MINIO_FLAT_MODULE = "file-minio-flat"

export default Module(FILE_MINIO_FLAT_MODULE, {
    service: FileMinioFlatService,
})
