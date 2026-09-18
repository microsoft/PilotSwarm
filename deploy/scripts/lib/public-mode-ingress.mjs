// Publish the Azure DNS label on the AKS application-routing addon's public
// LoadBalancer before Flux applies the cert-manager Ingress. The addon owns
// the Service, so its NginxIngressController CR is the durable configuration.
import { run, log } from "./common.mjs";

export function configurePublicModeIngress({ env, kubeEnv }) {
  if (env.EDGE_MODE !== "public") return;
  const hostname = String(env.PORTAL_HOSTNAME || "").toLowerCase();
  const suffix = `.${String(env.LOCATION || "").toLowerCase()}.cloudapp.azure.com`;
  if (!hostname.endsWith(suffix)) {
    throw new Error(`Public mode PORTAL_HOSTNAME must end with ${suffix}.`);
  }
  const label = hostname.slice(0, -suffix.length);
  if (!/^[a-z][a-z0-9-]{0,61}[a-z0-9]$/.test(label)) {
    throw new Error(`Public mode PORTAL_HOSTNAME has an invalid Azure DNS label: ${label}`);
  }
  const patch = JSON.stringify({
    spec: {
      loadBalancerAnnotations: {
        "service.beta.kubernetes.io/azure-dns-label-name": label,
        "service.beta.kubernetes.io/azure-load-balancer-internal": "false",
      },
    },
  });
  log("info", `[public-ingress] publishing ${hostname} on the AKS managed NGINX LoadBalancer`);
  run("kubectl", ["patch", "nginxingresscontroller", "default", "--type=merge", "-p", patch], { env: kubeEnv });
}
