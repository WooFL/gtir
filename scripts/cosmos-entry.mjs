// Vendor entry: expose cosmos as a browser global so the generated HTML can inline it via <script>.
import { Graph } from "@cosmograph/cosmos";
window.cosmos = { Graph };
