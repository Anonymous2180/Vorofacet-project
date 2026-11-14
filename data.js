/* Values transcribed from Tables 1 and 2 of the user-supplied manuscript.
   Mean ± standard deviation; no aggregation from historical experiment folders. */
window.VOROFACET_DATA = {
  figures: {
    nm: {file:"nonmanifold-comparison.webp", title:"Non-manifold object", width:3200, height:1505, caption:"Junction connectivity on a non-manifold object. Figure 8."},
    car: {file:"car-comparison.webp", title:"ShapeNet-Car", width:3201, height:1920, caption:"Exterior and interior reconstruction of a ShapeNet-Car model. Figure 9."}
  },
  tables: {
    nm: {
      caption:"Non-manifold Objects · 50 shapes · Table 1",
      rows:[
        ["MeshUDF","5.727±0.894","78.97±8.99","26.26±13.59","7.66±5.39","241.9±318.4"],
        ["CAP-UDF","5.939±0.734","76.26±8.31",null,null,"4157±3384"],
        ["GeoUDF","5.580±0.803","80.26±8.95","21.75±11.37","4.55±3.08","346.5±507.0"],
        ["MIND","5.959±0.752","76.70±7.41","38.62±19.13","2.33±4.03","76.76±113.25"],
        ["HR-UDF","5.580±0.818","80.30±9.08",null,null,"5421±5658"],
        ["DualMesh-UDF","5.632±0.814","79.77±9.05","8.715±3.960","3.82±2.04","17.06±36.54"],
        ["DCx","5.645±0.751","79.02±8.07","53.19±19.26","6.22±8.64","8.52±10.34"],
        ["DCUDF","5.563±0.826","80.18±8.89",null,null,"20.42±36.30"],
        ["DCUDF2","5.562±0.824","80.24±8.88",null,null,"20.42±36.30"],
        ["VoroFacet","5.549±0.831","80.46±8.98","65.80±21.37","37.07±17.23","1.380±1.086"]
      ]
    },
    car: {
      caption:"ShapeNet-Car · 20 models · Table 2",
      rows:[
        ["MeshUDF","6.073±0.968","76.51±8.62","6.354±2.188","2.84±1.12","1154±994"],
        ["CAP-UDF","5.784±0.791","78.55±8.54",null,null,"13342±8304"],
        ["GeoUDF","5.299±0.701","83.75±7.23","22.02±4.48","11.20±3.30","792.5±626.7"],
        ["MIND","6.393±0.813","75.52±7.37","8.881±5.194","4.78±4.29","126.1±74.5"],
        ["HR-UDF","5.309±0.718","84.15±7.47",null,null,"3432±1996"],
        ["DualMesh-UDF","5.388±0.739","83.05±7.37","22.47±4.72","12.71±3.56","51.7±44.7"],
        ["DCx","5.605±0.701","81.30±6.88","30.80±7.19","15.09±7.22","52.75±44.60"],
        ["DCUDF","5.304±0.690","83.48±7.04",null,null,"185.7±151.2"],
        ["DCUDF2","5.291±0.695","83.74±7.15",null,null,"185.9±151.4"],
        ["VoroFacet","5.370±0.687","83.61±7.05","36.67±8.44","18.91±8.50","13.95±11.90"]
      ]
    }
  }
};
