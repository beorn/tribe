/**
 * The real recall Worker over an empty in-memory recall index. A Worker does not see a RECALL_DB_PATH the test file
 * set on its own thread (measured: it opened the live index), so the index is chosen here, inside the Worker. The
 * import is static, so the Worker's message handler is in place before the first call arrives; db.ts reads the path
 * when it opens the index, after this line has run.
 */
import "../../src/lib/recall-worker.ts"

process.env.RECALL_DB_PATH = ":memory:"
