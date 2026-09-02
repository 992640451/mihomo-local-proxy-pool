import Ajv2020 from 'ajv/dist/2020.js'
import { API_SCHEMAS } from './contract.mjs'
import { apiError } from '../http/responses.mjs'

const ajv = new Ajv2020({ strict: false, validateFormats: false })
ajv.addSchema({ $id: 'ppm-api-v1', components: { schemas: API_SCHEMAS } })
export const apiSchemaValidator = name => ajv.getSchema(`ppm-api-v1#/components/schemas/${name}`)

export function validateRequest(operation) {
  const validate = operation.input ? apiSchemaValidator(operation.input) : null
  return (req, res, next) => {
    if (validate && !validate(req.body)) return apiError(req, res, { status: 400, code: 'INVALID_REQUEST', message: '请求不符合 API v1 数据格式', meta: { schema: operation.input } })
    if (req.params.port !== undefined && !/^(?:[1-9][0-9]{3,4})$/.test(req.params.port)) return apiError(req, res, { status: 400, code: 'INVALID_PORT', message: '端口格式无效' })
    if (req.params.port !== undefined && (Number(req.params.port) < 1024 || Number(req.params.port) > 65535)) return apiError(req, res, { status: 400, code: 'INVALID_PORT', message: '端口范围无效' })
    next()
  }
}
